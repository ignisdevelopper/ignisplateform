"""
core/advanced_patterns/iou_detector.py — IOU (Ignored Over & Under) detector (HLZ)

IOU = "Ignored Over & Under" :
1) Un pattern OU se produit sur une zone :
   - DEMAND : sweep sous la zone (under) puis reclaim au-dessus (over)  => OU bullish
   - SUPPLY : sweep au-dessus de la zone (over) puis reclaim sous la zone (under) => OU bearish
2) Le OU est ensuite "ignoré" rapidement :
   - OU bullish ignoré => le prix recasse sous la zone (continuation bearish)  => IOU BEARISH
   - OU bearish ignoré => le prix recasse au-dessus de la zone (continuation bullish) => IOU BULLISH

Interprétation :
- Le marché piège dans un sens (reclaim), puis reprend le sens du sweep.
- Signal souvent très fort (conviction / absorption).

Caractéristiques du module :
- Stateless
- Tolérant aux candles dict/obj (open/high/low/close)
- Zone obligatoire (zone_top/zone_bot/zone_type)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Candle / Zone helpers (tolérant)
# ═════════════════════════════════════════════════════════════════════════════=

@runtime_checkable
class CandleLike(Protocol):
    open: float
    high: float
    low: float
    close: float


def _c_get(c: Any, key: str, default: float = 0.0) -> float:
    if isinstance(c, dict):
        return float(c.get(key, default))
    return float(getattr(c, key, default))


def _z_get(z: Any, key: str, default: Any = None) -> Any:
    if z is None:
        return default
    if isinstance(z, dict):
        return z.get(key, default)
    return getattr(z, key, default)


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class IOUConfig:
    # Scan window
    lookback: int = 160

    # ATR
    atr_period: int = 14

    # On privilégie le OU "logique" par rapport au type de zone (demand => OU bullish, supply => OU bearish)
    prefer_zone_side: bool = True

    # OU formation
    reclaim_max_bars: int = 3                 # sweep -> reclaim doit arriver rapidement
    allow_same_candle_reclaim: bool = True    # wick sweep + close reclaim dans la même bougie

    sweep_min_atr_mult: float = 0.20          # dépassement minimal au-delà de la zone (en ATR)
    reclaim_buffer_atr_mult: float = 0.05     # close au-delà du bord opposé (en ATR) pour valider reclaim

    # Filtre bougie sweep/reclaim
    min_reclaim_body_to_range: float = 0.15   # évite reclaim doji
    min_reclaim_close_strength: float = 0.55  # close proche du high/low selon direction

    # "Ignored" : retour et cassure inverse (dans le sens du sweep) après le OU
    ignore_max_bars: int = 12                 # reclaim -> ignore doit arriver rapidement
    ignore_buffer_atr_mult: float = 0.05      # close au-delà du bord (en ATR)
    min_ignore_extension_atr_mult: float = 0.35  # extension minimale au-delà du bord (en ATR)

    # Scoring weights (0..1)
    w_sweep: float = 0.25
    w_reclaim: float = 0.25
    w_ignore: float = 0.35
    w_speed: float = 0.15


@dataclass
class IOUResult:
    detected: bool = False

    # direction = direction du signal IOU (direction attendue après "ignore")
    #   OU bullish ignoré => IOU BEARISH
    #   OU bearish ignoré => IOU BULLISH
    direction: str = ""              # "BULLISH" | "BEARISH"
    ou_direction: str = ""           # "BULLISH" | "BEARISH"
    strength: int = 0                # 0..100

    zone_type: Optional[str] = None
    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None
    atr: Optional[float] = None

    sweep_index: Optional[int] = None
    reclaim_index: Optional[int] = None
    ignore_index: Optional[int] = None

    sweep_distance: Optional[float] = None
    reclaim_close: Optional[float] = None
    ignore_close: Optional[float] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class IOUDetector:
    """
    Détecte un IOU sur une zone donnée.

    Utilisation typique (setup_scanner) :
        res = IOUDetector().detect(candles, zone)
        if res.detected: ...
    """

    def __init__(self, config: Optional[IOUConfig] = None) -> None:
        self.config = config or IOUConfig()

    def detect(self, candles: list[Any], zone: Any) -> IOUResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 40):
            return IOUResult(detected=False, details={"reason": "not_enough_candles"})

        if zone is None:
            return IOUResult(detected=False, details={"reason": "zone_required"})

        zone_top = _z_get(zone, "zone_top")
        zone_bot = _z_get(zone, "zone_bot")
        zt = _z_get(zone, "zone_type") or _z_get(zone, "type") or _z_get(zone, "zoneType") or ""
        zt_u = str(zt).upper()

        if zone_top is None or zone_bot is None:
            return IOUResult(detected=False, details={"reason": "zone_missing_bounds"})

        zone_top = float(zone_top)
        zone_bot = float(zone_bot)
        if zone_top < zone_bot:
            zone_top, zone_bot = zone_bot, zone_top

        if abs(zone_top - zone_bot) <= 0:
            return IOUResult(detected=False, details={"reason": "zone_invalid_height"})

        is_demand = any(k in zt_u for k in ("DEMAND", "FLIPPY_D", "HIDDEN_D"))
        is_supply = any(k in zt_u for k in ("SUPPLY", "FLIPPY_S", "HIDDEN_S"))
        if not (is_demand or is_supply):
            return IOUResult(detected=False, details={"reason": "unknown_zone_type", "zone_type": str(zt)})

        # Lookback slice
        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        base_index = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            return IOUResult(detected=False, details={"reason": "atr_invalid"})

        # On cherche la config la plus récente / la plus forte
        best: Optional[IOUResult] = None
        best_strength = 0

        # Déterminer le type de OU à chercher selon zone
        ou_types_to_scan: list[str]
        if cfg.prefer_zone_side:
            ou_types_to_scan = ["BULLISH"] if is_demand else ["BEARISH"]
        else:
            ou_types_to_scan = ["BULLISH", "BEARISH"]

        for ou_dir in ou_types_to_scan:
            # OU bullish => sweep DOWN puis reclaim UP
            # OU bearish => sweep UP puis reclaim DOWN
            candidates = _find_ou_sequences(
                candles=c,
                zone_top=zone_top,
                zone_bot=zone_bot,
                atr=atr,
                ou_direction=ou_dir,
                cfg=cfg,
            )

            for cand in candidates:
                sweep_i = cand["sweep_index"]
                reclaim_i = cand["reclaim_index"]
                sweep_dist = cand["sweep_distance"]
                reclaim_close = cand["reclaim_close"]
                reclaim_score = cand["reclaim_score01"]
                sweep_score = cand["sweep_score01"]

                ignore = _find_ignore_after_reclaim(
                    candles=c,
                    zone_top=zone_top,
                    zone_bot=zone_bot,
                    atr=atr,
                    ou_direction=ou_dir,
                    reclaim_index=reclaim_i,
                    cfg=cfg,
                )
                if ignore is None:
                    continue

                ignore_i = ignore["ignore_index"]
                ignore_close = ignore["ignore_close"]
                ignore_ext = ignore["ignore_extension"]
                ignore_score = ignore["ignore_score01"]
                speed_score = ignore["speed_score01"]

                # IOU direction = direction du sweep (opposé au OU)
                # OU bullish ignoré => IOU bearish ; OU bearish ignoré => IOU bullish
                iou_dir = "BEARISH" if ou_dir == "BULLISH" else "BULLISH"

                score01 = (
                    cfg.w_sweep * sweep_score
                    + cfg.w_reclaim * reclaim_score
                    + cfg.w_ignore * ignore_score
                    + cfg.w_speed * speed_score
                )
                strength = int(round(100 * _clip01(score01)))

                if strength >= best_strength:
                    best_strength = strength
                    best = IOUResult(
                        detected=True,
                        direction=iou_dir,
                        ou_direction=ou_dir,
                        strength=strength,
                        zone_type=str(zt),
                        zone_top=zone_top,
                        zone_bot=zone_bot,
                        atr=float(atr),
                        sweep_index=base_index + sweep_i,
                        reclaim_index=base_index + reclaim_i,
                        ignore_index=base_index + ignore_i,
                        sweep_distance=float(sweep_dist),
                        reclaim_close=float(reclaim_close),
                        ignore_close=float(ignore_close),
                        details={
                            "scores": {
                                "sweep": round(sweep_score, 3),
                                "reclaim": round(reclaim_score, 3),
                                "ignore": round(ignore_score, 3),
                                "speed": round(speed_score, 3),
                                "total01": round(_clip01(score01), 3),
                            },
                            "ou": {
                                "ou_direction": ou_dir,
                                "sweep_index": base_index + sweep_i,
                                "reclaim_index": base_index + reclaim_i,
                                "sweep_distance_atr": round(sweep_dist / atr, 3) if atr > 0 else None,
                            },
                            "ignore": {
                                "ignore_index": base_index + ignore_i,
                                "ignore_extension": ignore_ext,
                                "ignore_extension_atr": round(ignore_ext / atr, 3) if atr > 0 else None,
                                "bars_after_reclaim": (ignore_i - reclaim_i),
                            },
                        },
                    )

        if best is None:
            return IOUResult(
                detected=False,
                zone_type=str(zt),
                zone_top=zone_top,
                zone_bot=zone_bot,
                atr=float(atr),
                details={"reason": "no_iou_found"},
            )

        return best


# ═════════════════════════════════════════════════════════════════════════════=
# Internals
# ═════════════════════════════════════════════════════════════════════════════=

def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _range(c: Any) -> float:
    return max(0.0, _c_get(c, "high") - _c_get(c, "low"))


def _body(c: Any) -> float:
    return abs(_c_get(c, "close") - _c_get(c, "open"))


def _close_strength(c: Any, direction: str) -> float:
    """
    Renvoie 0..1 : où se situe le close dans le range.
    - bullish: close proche du high => score élevé
    - bearish: close proche du low  => score élevé
    """
    h = _c_get(c, "high")
    l = _c_get(c, "low")
    cl = _c_get(c, "close")
    rng = max(1e-12, h - l)
    if direction == "BULLISH":
        return _clip01((cl - l) / rng)
    return _clip01((h - cl) / rng)


def _compute_atr(candles: list[Any], period: int) -> float:
    if len(candles) < period + 2:
        return 0.0
    trs: list[float] = []
    start = len(candles) - period - 1
    for i in range(start + 1, len(candles)):
        cur = candles[i]
        prev = candles[i - 1]
        h = _c_get(cur, "high")
        l = _c_get(cur, "low")
        pc = _c_get(prev, "close")
        tr = max(h - l, abs(h - pc), abs(l - pc))
        if tr > 0:
            trs.append(tr)
    return (sum(trs) / len(trs)) if trs else 0.0


def _find_ou_sequences(
    *,
    candles: list[Any],
    zone_top: float,
    zone_bot: float,
    atr: float,
    ou_direction: str,  # "BULLISH" or "BEARISH"
    cfg: IOUConfig,
) -> list[dict[str, Any]]:
    """
    Retourne une liste de OU candidats:
      - sweep_index, reclaim_index, sweep_distance, reclaim_close, scores
    """
    n = len(candles)
    res: list[dict[str, Any]] = []

    sweep_min = cfg.sweep_min_atr_mult * atr
    reclaim_buf = cfg.reclaim_buffer_atr_mult * atr

    # On ne scanne pas toute l'histoire : focus surtout la fin de lookback
    # (mais suffisamment pour trouver sweep->reclaim->ignore)
    for s in range(0, n - 2):
        cs = candles[s]
        lo = _c_get(cs, "low")
        hi = _c_get(cs, "high")
        cl = _c_get(cs, "close")

        if ou_direction == "BULLISH":
            # sweep sous zone_bot
            swept = (lo <= zone_bot - sweep_min)
            if not swept:
                continue

            sweep_dist = (zone_bot - lo)
            sweep_score = _clip01(sweep_dist / max(1e-9, sweep_min) - 1.0)

            # reclaim : close au-dessus du zone_top (+ buffer) dans les next reclaim_max_bars
            r_end = min(n - 1, s + cfg.reclaim_max_bars)
            for r in range(s, r_end + 1):
                cr = candles[r]
                r_close = _c_get(cr, "close")
                if r == s and not cfg.allow_same_candle_reclaim:
                    continue
                if r_close < (zone_top + reclaim_buf):
                    continue

                # filtre reclaim candle
                rrng = _range(cr)
                if rrng <= 0:
                    continue
                if (_body(cr) / rrng) < cfg.min_reclaim_body_to_range:
                    continue
                if _close_strength(cr, "BULLISH") < cfg.min_reclaim_close_strength:
                    continue

                reclaim_excess = r_close - (zone_top + reclaim_buf)
                reclaim_score = _clip01(reclaim_excess / max(1e-9, atr) )  # >=1 ATR => 1

                res.append({
                    "sweep_index": s,
                    "reclaim_index": r,
                    "sweep_distance": sweep_dist,
                    "reclaim_close": r_close,
                    "sweep_score01": sweep_score,
                    "reclaim_score01": reclaim_score,
                })
                break  # on prend le premier reclaim valide (le plus rapide)
        else:
            # OU BEARISH : sweep au-dessus zone_top
            swept = (hi >= zone_top + sweep_min)
            if not swept:
                continue

            sweep_dist = (hi - zone_top)
            sweep_score = _clip01(sweep_dist / max(1e-9, sweep_min) - 1.0)

            # reclaim : close sous zone_bot (- buffer)
            r_end = min(n - 1, s + cfg.reclaim_max_bars)
            for r in range(s, r_end + 1):
                cr = candles[r]
                r_close = _c_get(cr, "close")
                if r == s and not cfg.allow_same_candle_reclaim:
                    continue
                if r_close > (zone_bot - reclaim_buf):
                    continue

                rrng = _range(cr)
                if rrng <= 0:
                    continue
                if (_body(cr) / rrng) < cfg.min_reclaim_body_to_range:
                    continue
                if _close_strength(cr, "BEARISH") < cfg.min_reclaim_close_strength:
                    continue

                reclaim_excess = (zone_bot - reclaim_buf) - r_close
                reclaim_score = _clip01(reclaim_excess / max(1e-9, atr))

                res.append({
                    "sweep_index": s,
                    "reclaim_index": r,
                    "sweep_distance": sweep_dist,
                    "reclaim_close": r_close,
                    "sweep_score01": sweep_score,
                    "reclaim_score01": reclaim_score,
                })
                break

    # Prioriser les OU les plus récents
    res.sort(key=lambda x: x["reclaim_index"], reverse=True)
    return res


def _find_ignore_after_reclaim(
    *,
    candles: list[Any],
    zone_top: float,
    zone_bot: float,
    atr: float,
    ou_direction: str,
    reclaim_index: int,
    cfg: IOUConfig,
) -> Optional[dict[str, Any]]:
    """
    Cherche la "cassure d'ignore" après le reclaim :
    - OU bullish -> ignore = close < zone_bot - buffer (bearish continuation)
    - OU bearish -> ignore = close > zone_top + buffer (bullish continuation)
    """
    n = len(candles)
    if reclaim_index >= n - 1:
        return None

    ignore_buf = cfg.ignore_buffer_atr_mult * atr
    min_ext = cfg.min_ignore_extension_atr_mult * atr

    start = reclaim_index + 1
    end = min(n - 1, reclaim_index + cfg.ignore_max_bars)

    for j in range(start, end + 1):
        cj = candles[j]
        cl = _c_get(cj, "close")

        if ou_direction == "BULLISH":
            # ignore => recasse sous zone_bot
            if cl >= (zone_bot - ignore_buf):
                continue
            extension = (zone_bot - ignore_buf) - cl
            if extension < min_ext:
                continue
        else:
            # ignore => recasse au-dessus zone_top
            if cl <= (zone_top + ignore_buf):
                continue
            extension = cl - (zone_top + ignore_buf)
            if extension < min_ext:
                continue

        ignore_score = _clip01(extension / max(1e-9, min_ext) - 1.0)
        bars = (j - reclaim_index)
        speed_score = _clip01(1.0 - (bars - 1) / max(1, cfg.ignore_max_bars))

        return {
            "ignore_index": j,
            "ignore_close": cl,
            "ignore_extension": extension,
            "ignore_score01": ignore_score,
            "speed_score01": speed_score,
        }

    return None
