"""
core/base_engine/hidden_base.py — Hidden Base (HB) / Kissing Candle detector (HLZ)

But :
- Détecter une "Hidden Base" (micro-base) souvent visible en LTF :
  • plusieurs bougies "kissent" un niveau (lows presque égaux en demand / highs presque égaux en supply)
  • base très serrée (compression)
  • puis un départ (impulsion) clair "away" de ce niveau

Interprétation HLZ :
- HIDDEN_D : micro-base de demande (support caché) -> départ haussier
- HIDDEN_S : micro-base d'offre (résistance cachée) -> départ baissier
- Souvent utilisée comme confluence / refinement d'entrée dans une zone HTF.

Design :
- Stateless
- Tolérant : candles en dict ou objet (open/high/low/close)
- Zone/level de référence optionnel (parent zone/base) pour scorer la proximité.

API :
    det = HiddenBaseDetector()
    res = det.detect(candles, reference_zone=zone)  # zone optionnelle
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


def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _range(c: Any) -> float:
    return max(0.0, _c_get(c, "high") - _c_get(c, "low"))


def _body(c: Any) -> float:
    return abs(_c_get(c, "close") - _c_get(c, "open"))


def _compute_atr(candles: list[Any], period: int = 14) -> float:
    """ATR simple (TR moyen) sur les dernières bougies."""
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


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class HiddenBaseConfig:
    # Fenêtre de scan
    lookback: int = 180

    # Normalisation
    atr_period: int = 14

    # Base serrée (micro-base)
    min_base_candles: int = 2
    max_base_candles: int = 5
    max_base_height_atr_mult: float = 0.60          # (top-bot) <= X*ATR
    max_avg_candle_range_atr_mult: float = 0.70     # ranges moyens faibles

    # Kissing definition
    min_kisses: int = 2
    kiss_tolerance_atr_mult: float = 0.12           # lows/highs quasi égaux (tolérance en ATR)
    min_kiss_ratio: float = 0.65                    # kisses / nb bougies base

    # Departure "away"
    departure_lookahead: int = 4
    min_departure_net_atr_mult: float = 1.00        # net move >= X*ATR
    departure_close_buffer_atr_mult: float = 0.05   # close doit dépasser base edge + buffer*ATR

    # Proximité d'une zone de référence (optionnel)
    use_reference_zone: bool = True
    reference_proximity_atr_mult: float = 0.35      # distance <= X*ATR => bon score

    # Scoring weights (0..1)
    w_kisses: float = 0.35
    w_tightness: float = 0.25
    w_departure: float = 0.30
    w_proximity: float = 0.10


@dataclass
class HiddenBaseResult:
    detected: bool = False
    hidden_type: str = ""            # "HIDDEN_D" | "HIDDEN_S"
    direction: str = ""              # "BULLISH" | "BEARISH"
    strength: int = 0                # 0..100

    base_start_index: Optional[int] = None
    base_end_index: Optional[int] = None
    departure_index: Optional[int] = None

    base_top: Optional[float] = None
    base_bot: Optional[float] = None
    base_height: Optional[float] = None

    kiss_level: Optional[float] = None
    kiss_count: int = 0
    kisses_ratio: float = 0.0

    atr: Optional[float] = None
    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class HiddenBaseDetector:
    """
    Détecteur Hidden Base.

    Paramètres optionnels :
    - reference_zone : dict|obj avec zone_top/zone_bot/zone_type (pour confluence/proximité)
    - direction_hint : "BULLISH"|"BEARISH" si tu veux forcer la recherche (sinon auto à partir zone_type)
    """

    def __init__(self, config: Optional[HiddenBaseConfig] = None) -> None:
        self.config = config or HiddenBaseConfig()

    def detect(
        self,
        candles: list[Any],
        reference_zone: Optional[Any] = None,
        direction_hint: Optional[str] = None,
    ) -> HiddenBaseResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 40):
            return HiddenBaseResult(detected=False, details={"reason": "not_enough_candles"})

        # Focus lookback
        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            return HiddenBaseResult(detected=False, details={"reason": "atr_invalid"})

        # Determine which side(s) to scan
        scan_dirs: list[str] = []

        if direction_hint:
            dh = direction_hint.upper().strip()
            if dh in ("BULLISH", "BEARISH"):
                scan_dirs = [dh]

        if not scan_dirs:
            # try infer from reference zone type if provided
            zt = str(_z_get(reference_zone, "zone_type", "") or _z_get(reference_zone, "type", "")).upper()
            if any(k in zt for k in ("DEMAND", "FLIPPY_D", "HIDDEN_D")):
                scan_dirs = ["BULLISH"]  # hidden demand
            elif any(k in zt for k in ("SUPPLY", "FLIPPY_S", "HIDDEN_S")):
                scan_dirs = ["BEARISH"]  # hidden supply
            else:
                scan_dirs = ["BULLISH", "BEARISH"]

        best: HiddenBaseResult = HiddenBaseResult(detected=False, atr=float(atr))
        best_strength = 0

        # Reference zone bounds (optional)
        ref_top = _z_get(reference_zone, "zone_top")
        ref_bot = _z_get(reference_zone, "zone_bot")
        if ref_top is not None and ref_bot is not None:
            ref_top = float(ref_top)
            ref_bot = float(ref_bot)
            if ref_top < ref_bot:
                ref_top, ref_bot = ref_bot, ref_top

        # Scan recent bases (we prefer most recent / strongest)
        # base_start must allow departure lookahead after base_end
        max_base_end = len(c) - 1 - cfg.departure_lookahead
        if max_base_end <= cfg.min_base_candles:
            return HiddenBaseResult(detected=False, atr=float(atr), details={"reason": "not_enough_room_for_departure"})

        # Iterate base_end from most recent backward (prefer recency)
        for base_end in range(max_base_end, cfg.min_base_candles - 1, -1):
            for base_len in range(cfg.min_base_candles, cfg.max_base_candles + 1):
                base_start = base_end - base_len + 1
                if base_start < 1:
                    continue

                base_win = c[base_start : base_end + 1]
                if not base_win:
                    continue

                # Base tightness filters
                highs = [_c_get(x, "high") for x in base_win]
                lows = [_c_get(x, "low") for x in base_win]
                b_top = max(highs)
                b_bot = min(lows)
                height = b_top - b_bot
                if height <= 0:
                    continue
                if height > cfg.max_base_height_atr_mult * atr:
                    continue

                avg_rng = sum(_range(x) for x in base_win) / len(base_win)
                if avg_rng > cfg.max_avg_candle_range_atr_mult * atr:
                    continue

                # Evaluate each direction
                for dir_ in scan_dirs:
                    if dir_ == "BULLISH":
                        # Hidden demand: "kissing" lows
                        kiss_level, kiss_count, kisses_ratio = _kissing_level_lows(
                            base_win, atr, cfg.kiss_tolerance_atr_mult
                        )
                        hidden_type = "HIDDEN_D"
                        dep_ok, dep_meta = _check_departure(
                            candles=c,
                            base_end=base_end,
                            base_top=b_top,
                            base_bot=b_bot,
                            atr=atr,
                            direction="BULLISH",
                            cfg=cfg,
                        )
                    else:
                        # Hidden supply: "kissing" highs
                        kiss_level, kiss_count, kisses_ratio = _kissing_level_highs(
                            base_win, atr, cfg.kiss_tolerance_atr_mult
                        )
                        hidden_type = "HIDDEN_S"
                        dep_ok, dep_meta = _check_departure(
                            candles=c,
                            base_end=base_end,
                            base_top=b_top,
                            base_bot=b_bot,
                            atr=atr,
                            direction="BEARISH",
                            cfg=cfg,
                        )

                    if kiss_count < cfg.min_kisses:
                        continue
                    if kisses_ratio < cfg.min_kiss_ratio:
                        continue
                    if not dep_ok:
                        continue

                    # Proximity to reference zone (optional)
                    proximity_score = 0.0
                    prox_dist = None
                    if cfg.use_reference_zone and ref_top is not None and ref_bot is not None and kiss_level is not None:
                        # distance to nearest ref boundary
                        # for demand => closeness to ref_top or inside zone is good
                        # for supply => closeness to ref_bot or inside zone is good
                        if dir_ == "BULLISH":
                            # kiss level should be near ref_top (or inside)
                            dist = 0.0 if (ref_bot <= kiss_level <= ref_top) else abs(kiss_level - ref_top)
                        else:
                            dist = 0.0 if (ref_bot <= kiss_level <= ref_top) else abs(kiss_level - ref_bot)
                        prox_dist = dist
                        proximity_score = _clip01(1.0 - (dist / max(1e-9, cfg.reference_proximity_atr_mult * atr)))

                    # Scores
                    kisses_score = _clip01((kisses_ratio - cfg.min_kiss_ratio) / max(1e-9, (1.0 - cfg.min_kiss_ratio)))

                    tight_height_score = _clip01(1.0 - (height / max(1e-9, cfg.max_base_height_atr_mult * atr)))
                    tight_rng_score = _clip01(1.0 - (avg_rng / max(1e-9, cfg.max_avg_candle_range_atr_mult * atr)))
                    tightness_score = _clip01(0.6 * tight_height_score + 0.4 * tight_rng_score)

                    departure_score = dep_meta.get("departure_score01", 0.0)

                    score01 = (
                        cfg.w_kisses * kisses_score
                        + cfg.w_tightness * tightness_score
                        + cfg.w_departure * departure_score
                        + cfg.w_proximity * proximity_score
                    )
                    strength = int(round(100 * _clip01(score01)))

                    if strength > best_strength:
                        best_strength = strength
                        best = HiddenBaseResult(
                            detected=True,
                            hidden_type=hidden_type,
                            direction=dir_,
                            strength=strength,
                            base_start_index=offset + base_start,
                            base_end_index=offset + base_end,
                            departure_index=offset + dep_meta.get("departure_index") if dep_meta.get("departure_index") is not None else None,
                            base_top=float(b_top),
                            base_bot=float(b_bot),
                            base_height=float(height),
                            kiss_level=float(kiss_level) if kiss_level is not None else None,
                            kiss_count=int(kiss_count),
                            kisses_ratio=float(round(kisses_ratio, 3)),
                            atr=float(atr),
                            details={
                                "scores": {
                                    "kisses": round(kisses_score, 3),
                                    "tightness": round(tightness_score, 3),
                                    "departure": round(departure_score, 3),
                                    "proximity": round(proximity_score, 3),
                                    "total01": round(_clip01(score01), 3),
                                },
                                "base_stats": {
                                    "height": height,
                                    "height_atr": round(height / atr, 3) if atr > 0 else None,
                                    "avg_range": avg_rng,
                                    "avg_range_atr": round(avg_rng / atr, 3) if atr > 0 else None,
                                    "len": len(base_win),
                                },
                                "kissing": {
                                    "kiss_level": kiss_level,
                                    "kiss_count": kiss_count,
                                    "kisses_ratio": round(kisses_ratio, 3),
                                    "tolerance": cfg.kiss_tolerance_atr_mult * atr,
                                },
                                "departure": dep_meta,
                                "reference_zone": {
                                    "enabled": cfg.use_reference_zone,
                                    "ref_top": ref_top,
                                    "ref_bot": ref_bot,
                                    "prox_dist": prox_dist,
                                    "prox_dist_atr": round((prox_dist / atr), 3) if (prox_dist is not None and atr > 0) else None,
                                },
                            },
                        )

            # micro-optimisation : si on a déjà un très bon score sur les bougies récentes, stop early
            if best_strength >= 95:
                return best

        return best


# ═════════════════════════════════════════════════════════════════════════════=
# Internals — kissing & departure
# ═════════════════════════════════════════════════════════════════════════════=

def _kissing_level_lows(base_win: list[Any], atr: float, tol_mult: float) -> tuple[Optional[float], int, float]:
    """
    Kissing lows = plusieurs lows dans une tolérance.
    Retourne (kiss_level, kiss_count, ratio).
    """
    if not base_win:
        return None, 0, 0.0
    tol = max(1e-12, tol_mult * atr)
    lows = [_c_get(x, "low") for x in base_win]
    ref = min(lows)  # le niveau "kissé" est proche du plus bas
    kisses = sum(1 for lo in lows if abs(lo - ref) <= tol)
    ratio = kisses / len(base_win)
    # kiss_level = moyenne des lows "kissing"
    kiss_vals = [lo for lo in lows if abs(lo - ref) <= tol]
    kiss_level = (sum(kiss_vals) / len(kiss_vals)) if kiss_vals else ref
    return kiss_level, kisses, ratio


def _kissing_level_highs(base_win: list[Any], atr: float, tol_mult: float) -> tuple[Optional[float], int, float]:
    """Kissing highs = plusieurs highs dans une tolérance."""
    if not base_win:
        return None, 0, 0.0
    tol = max(1e-12, tol_mult * atr)
    highs = [_c_get(x, "high") for x in base_win]
    ref = max(highs)
    kisses = sum(1 for hi in highs if abs(hi - ref) <= tol)
    ratio = kisses / len(base_win)
    kiss_vals = [hi for hi in highs if abs(hi - ref) <= tol]
    kiss_level = (sum(kiss_vals) / len(kiss_vals)) if kiss_vals else ref
    return kiss_level, kisses, ratio


def _check_departure(
    *,
    candles: list[Any],
    base_end: int,
    base_top: float,
    base_bot: float,
    atr: float,
    direction: str,   # "BULLISH" | "BEARISH"
    cfg: HiddenBaseConfig,
) -> tuple[bool, dict[str, Any]]:
    """
    Vérifie qu'après la base il y a un mouvement "away" clair.
    """
    dep_start = base_end + 1
    dep_end = min(len(candles) - 1, dep_start + cfg.departure_lookahead - 1)
    if dep_start > dep_end:
        return False, {"reason": "no_departure_room"}

    win = candles[dep_start : dep_end + 1]
    buf = cfg.departure_close_buffer_atr_mult * atr
    min_net = cfg.min_departure_net_atr_mult * atr

    if direction == "BULLISH":
        max_high = max(_c_get(x, "high") for x in win)
        max_close = max(_c_get(x, "close") for x in win)
        net = max(0.0, max_high - base_top)
        close_ok = max_close >= (base_top + buf)
    else:
        min_low = min(_c_get(x, "low") for x in win)
        min_close = min(_c_get(x, "close") for x in win)
        net = max(0.0, base_bot - min_low)
        close_ok = min_close <= (base_bot - buf)

    if not close_ok:
        return False, {"reason": "departure_close_not_confirmed", "buffer": buf}

    if net < min_net:
        return False, {"reason": "departure_net_too_small", "net": net, "min_required": min_net}

    # index de la bougie de départ (celle qui fait le max move)
    if direction == "BULLISH":
        dep_idx = dep_start + max(range(len(win)), key=lambda i: _c_get(win[i], "high"))
    else:
        dep_idx = dep_start + min(range(len(win)), key=lambda i: _c_get(win[i], "low"))

    # score 0..1 : net / min_net, cap à 1.5*min_net
    departure_score01 = _clip01(net / max(1e-9, min_net))

    return True, {
        "departure_index": dep_idx,
        "departure_net": net,
        "departure_net_atr": round(net / atr, 3) if atr > 0 else None,
        "min_required": min_net,
        "buffer": buf,
        "direction": direction,
        "departure_score01": round(departure_score01, 3),
    }
