"""
core/advanced_patterns/over_under.py — Over & Under (OU) detector (HLZ)
+ Golden Zone confluence (optionnelle)

OU (Over & Under) sur zone S&D :
- DEMAND (bullish OU) :
    1) Sweep "UNDER" : le prix chasse sous zone_bot (liquidité)
    2) Reclaim "OVER" : le prix clôture au-dessus de zone_top (réintégration forte)
- SUPPLY (bearish OU) :
    1) Sweep "OVER" : le prix chasse au-dessus de zone_top
    2) Reclaim "UNDER" : le prix clôture sous zone_bot

Golden Zone (optionnelle) :
Après le reclaim, on mesure la jambe OU (extreme_sweep → reclaim_close) et on check
un pullback dans la zone fib 0.618–0.786 (golden zone) dans un délai court.
Cela donne une confluence "institutionnelle" (retest propre) sans invalider le reclaim.

Design :
- Stateless
- Tolérant dict/obj pour candles et zone
- Renvoie un OverUnderResult structuré + scoring [0..100]
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
class OverUnderConfig:
    # Scan window
    lookback: int = 180
    atr_period: int = 14

    # OU direction preference
    prefer_zone_side: bool = True  # demand => OU bullish, supply => OU bearish

    # Sweep / reclaim timing
    reclaim_max_bars: int = 4
    allow_same_candle_reclaim: bool = True

    # Sweep requirements
    sweep_min_atr_mult: float = 0.20          # dépassement minimal en ATR au-delà de la zone
    reclaim_buffer_atr_mult: float = 0.05     # reclaim close doit dépasser le bord opposé de buffer*ATR

    # Reclaim candle quality
    min_reclaim_body_to_range: float = 0.15
    min_reclaim_close_strength: float = 0.55  # close proche high(bull) / low(bear)

    # Golden zone (fib pullback) after reclaim
    golden_zone_enabled: bool = True
    golden_zone_required: bool = False
    golden_zone_min_fib: float = 0.618
    golden_zone_max_fib: float = 0.786
    golden_zone_max_bars: int = 12

    # Golden zone validity (ne pas "casser" le reclaim)
    # Bullish : on tolère pullback mais pas de close net sous zone_bot - buffer
    # Bearish : pas de close net au-dessus zone_top + buffer
    invalidate_reclaim_buffer_atr_mult: float = 0.03

    # Scoring weights (0..1)
    w_sweep: float = 0.30
    w_reclaim: float = 0.40
    w_speed: float = 0.15
    w_golden: float = 0.15


@dataclass
class OverUnderResult:
    detected: bool = False
    direction: str = ""              # "BULLISH" | "BEARISH"
    strength: int = 0                # 0..100

    golden_zone: bool = False
    golden_zone_range: Optional[tuple[float, float]] = None
    golden_zone_hit_index: Optional[int] = None

    zone_type: Optional[str] = None
    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None
    atr: Optional[float] = None

    sweep_index: Optional[int] = None
    reclaim_index: Optional[int] = None
    sweep_extreme: Optional[float] = None     # low for bullish OU / high for bearish OU
    reclaim_close: Optional[float] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class OverUnderDetector:
    """
    Détecte un Over & Under sur une zone S&D.

    Usage :
        res = OverUnderDetector().detect(candles, zone)
        if res.detected and res.golden_zone: ...
    """

    def __init__(self, config: Optional[OverUnderConfig] = None) -> None:
        self.config = config or OverUnderConfig()

    def detect(self, candles: list[Any], zone: Any) -> OverUnderResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 40):
            return OverUnderResult(detected=False, details={"reason": "not_enough_candles"})

        if zone is None:
            return OverUnderResult(detected=False, details={"reason": "zone_required"})

        zone_top = _z_get(zone, "zone_top")
        zone_bot = _z_get(zone, "zone_bot")
        zt = _z_get(zone, "zone_type") or _z_get(zone, "type") or _z_get(zone, "zoneType") or ""
        zt_u = str(zt).upper()

        if zone_top is None or zone_bot is None:
            return OverUnderResult(detected=False, details={"reason": "zone_missing_bounds"})

        zone_top = float(zone_top)
        zone_bot = float(zone_bot)
        if zone_top < zone_bot:
            zone_top, zone_bot = zone_bot, zone_top

        if abs(zone_top - zone_bot) <= 0:
            return OverUnderResult(detected=False, details={"reason": "zone_invalid_height"})

        is_demand = any(k in zt_u for k in ("DEMAND", "FLIPPY_D", "HIDDEN_D"))
        is_supply = any(k in zt_u for k in ("SUPPLY", "FLIPPY_S", "HIDDEN_S"))
        if not (is_demand or is_supply):
            return OverUnderResult(detected=False, details={"reason": "unknown_zone_type", "zone_type": str(zt)})

        # focus lookback
        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        base_index = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            return OverUnderResult(detected=False, details={"reason": "atr_invalid"})

        # Directions to scan
        if cfg.prefer_zone_side:
            directions = ["BULLISH"] if is_demand else ["BEARISH"]
        else:
            directions = ["BULLISH", "BEARISH"]

        best: Optional[OverUnderResult] = None
        best_strength = 0

        for ou_dir in directions:
            candidates = _find_ou_candidates(
                candles=c,
                zone_top=zone_top,
                zone_bot=zone_bot,
                atr=atr,
                direction=ou_dir,
                cfg=cfg,
            )

            for cand in candidates:
                sweep_i = cand["sweep_index"]
                reclaim_i = cand["reclaim_index"]
                sweep_extreme = cand["sweep_extreme"]
                reclaim_close = cand["reclaim_close"]

                sweep_score = cand["sweep_score01"]
                reclaim_score = cand["reclaim_score01"]
                speed_score = cand["speed_score01"]

                # Golden zone check
                gz_hit = False
                gz_range = None
                gz_hit_index = None
                gz_score = 0.0

                if cfg.golden_zone_enabled:
                    gz = _check_golden_zone_pullback(
                        candles=c,
                        zone_top=zone_top,
                        zone_bot=zone_bot,
                        atr=atr,
                        direction=ou_dir,
                        sweep_index=sweep_i,
                        reclaim_index=reclaim_i,
                        sweep_extreme=sweep_extreme,
                        reclaim_close=reclaim_close,
                        cfg=cfg,
                    )
                    gz_hit = gz["hit"]
                    gz_range = gz["range"]
                    gz_hit_index = gz["hit_index"]
                    gz_score = gz["score01"]

                    if cfg.golden_zone_required and not gz_hit:
                        continue

                # Score final
                score01 = (
                    cfg.w_sweep * sweep_score
                    + cfg.w_reclaim * reclaim_score
                    + cfg.w_speed * speed_score
                    + cfg.w_golden * gz_score
                )
                strength = int(round(100 * _clip01(score01)))

                if strength >= best_strength:
                    best_strength = strength
                    best = OverUnderResult(
                        detected=True,
                        direction=ou_dir,
                        strength=strength,
                        golden_zone=bool(gz_hit),
                        golden_zone_range=gz_range,
                        golden_zone_hit_index=(base_index + gz_hit_index) if gz_hit_index is not None else None,
                        zone_type=str(zt),
                        zone_top=zone_top,
                        zone_bot=zone_bot,
                        atr=float(atr),
                        sweep_index=base_index + sweep_i,
                        reclaim_index=base_index + reclaim_i,
                        sweep_extreme=float(sweep_extreme),
                        reclaim_close=float(reclaim_close),
                        details={
                            "scores": {
                                "sweep": round(sweep_score, 3),
                                "reclaim": round(reclaim_score, 3),
                                "speed": round(speed_score, 3),
                                "golden": round(gz_score, 3),
                                "total01": round(_clip01(score01), 3),
                            },
                            "ou": {
                                "direction": ou_dir,
                                "sweep_index": base_index + sweep_i,
                                "reclaim_index": base_index + reclaim_i,
                                "sweep_extreme": sweep_extreme,
                                "reclaim_close": reclaim_close,
                                "reclaim_bars": reclaim_i - sweep_i,
                            },
                            "golden_zone": {
                                "enabled": cfg.golden_zone_enabled,
                                "hit": gz_hit,
                                "range": gz_range,
                                "hit_index": (base_index + gz_hit_index) if gz_hit_index is not None else None,
                            },
                        },
                    )

        if best is None:
            return OverUnderResult(
                detected=False,
                zone_type=str(zt),
                zone_top=zone_top,
                zone_bot=zone_bot,
                atr=float(atr),
                details={"reason": "no_ou_found"},
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
    0..1 : position du close dans le range.
    - bullish => close proche du high => score élevé
    - bearish => close proche du low  => score élevé
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


def _find_ou_candidates(
    *,
    candles: list[Any],
    zone_top: float,
    zone_bot: float,
    atr: float,
    direction: str,  # "BULLISH" | "BEARISH" (OU direction)
    cfg: OverUnderConfig,
) -> list[dict[str, Any]]:
    """
    OU bullish:
      sweep UNDER => low <= zone_bot - sweep_min
      reclaim OVER => close >= zone_top + reclaim_buf
    OU bearish:
      sweep OVER => high >= zone_top + sweep_min
      reclaim UNDER => close <= zone_bot - reclaim_buf
    """
    n = len(candles)
    res: list[dict[str, Any]] = []

    sweep_min = cfg.sweep_min_atr_mult * atr
    reclaim_buf = cfg.reclaim_buffer_atr_mult * atr

    for s in range(0, n - 2):
        cs = candles[s]
        lo = _c_get(cs, "low")
        hi = _c_get(cs, "high")

        if direction == "BULLISH":
            if lo > (zone_bot - sweep_min):
                continue

            # sweep extreme = minimum low jusqu'au reclaim (inclus)
            # reclaim dans la fenêtre
            r_end = min(n - 1, s + cfg.reclaim_max_bars)
            for r in range(s, r_end + 1):
                if r == s and not cfg.allow_same_candle_reclaim:
                    continue
                cr = candles[r]
                r_close = _c_get(cr, "close")
                if r_close < (zone_top + reclaim_buf):
                    continue

                # reclaim candle quality
                rrng = _range(cr)
                if rrng <= 0:
                    continue
                if (_body(cr) / rrng) < cfg.min_reclaim_body_to_range:
                    continue
                if _close_strength(cr, "BULLISH") < cfg.min_reclaim_close_strength:
                    continue

                sweep_ext = min(_c_get(candles[k], "low") for k in range(s, r + 1))
                sweep_dist = (zone_bot - sweep_ext)
                sweep_score = _clip01(sweep_dist / max(1e-9, sweep_min) - 1.0)

                reclaim_excess = r_close - (zone_top + reclaim_buf)
                reclaim_score = _clip01(reclaim_excess / max(1e-9, atr))  # 1 ATR => 1

                bars = max(1, r - s)
                speed_score = _clip01(1.0 - (bars - 1) / max(1, cfg.reclaim_max_bars))

                res.append({
                    "sweep_index": s,
                    "reclaim_index": r,
                    "sweep_extreme": sweep_ext,
                    "reclaim_close": r_close,
                    "sweep_score01": sweep_score,
                    "reclaim_score01": reclaim_score,
                    "speed_score01": speed_score,
                })
                break

        else:
            if hi < (zone_top + sweep_min):
                continue

            r_end = min(n - 1, s + cfg.reclaim_max_bars)
            for r in range(s, r_end + 1):
                if r == s and not cfg.allow_same_candle_reclaim:
                    continue
                cr = candles[r]
                r_close = _c_get(cr, "close")
                if r_close > (zone_bot - reclaim_buf):
                    continue

                rrng = _range(cr)
                if rrng <= 0:
                    continue
                if (_body(cr) / rrng) < cfg.min_reclaim_body_to_range:
                    continue
                if _close_strength(cr, "BEARISH") < cfg.min_reclaim_close_strength:
                    continue

                sweep_ext = max(_c_get(candles[k], "high") for k in range(s, r + 1))
                sweep_dist = (sweep_ext - zone_top)
                sweep_score = _clip01(sweep_dist / max(1e-9, sweep_min) - 1.0)

                reclaim_excess = (zone_bot - reclaim_buf) - r_close
                reclaim_score = _clip01(reclaim_excess / max(1e-9, atr))

                bars = max(1, r - s)
                speed_score = _clip01(1.0 - (bars - 1) / max(1, cfg.reclaim_max_bars))

                res.append({
                    "sweep_index": s,
                    "reclaim_index": r,
                    "sweep_extreme": sweep_ext,
                    "reclaim_close": r_close,
                    "sweep_score01": sweep_score,
                    "reclaim_score01": reclaim_score,
                    "speed_score01": speed_score,
                })
                break

    # Priorité aux setups les plus récents
    res.sort(key=lambda x: x["reclaim_index"], reverse=True)
    return res


def _check_golden_zone_pullback(
    *,
    candles: list[Any],
    zone_top: float,
    zone_bot: float,
    atr: float,
    direction: str,
    sweep_index: int,
    reclaim_index: int,
    sweep_extreme: float,
    reclaim_close: float,
    cfg: OverUnderConfig,
) -> dict[str, Any]:
    """
    Golden zone fib sur la jambe OU (extreme_sweep -> reclaim_close).
    On cherche un pullback dans [0.618..0.786] dans un délai court, sans invalider le reclaim.
    """
    if reclaim_index >= len(candles) - 1:
        return {"hit": False, "range": None, "hit_index": None, "score01": 0.0}

    leg = (reclaim_close - sweep_extreme) if direction == "BULLISH" else (sweep_extreme - reclaim_close)
    if leg <= 0:
        return {"hit": False, "range": None, "hit_index": None, "score01": 0.0}

    # Golden zone levels in price terms
    f1 = cfg.golden_zone_min_fib
    f2 = cfg.golden_zone_max_fib

    if direction == "BULLISH":
        gz_lo = sweep_extreme + f1 * leg
        gz_hi = sweep_extreme + f2 * leg
        # invalidate if close < zone_bot - buffer
        inv_level = zone_bot - cfg.invalidate_reclaim_buffer_atr_mult * atr
        in_zone = lambda price: (gz_lo <= price <= gz_hi)
        get_probe = lambda candle: _c_get(candle, "low")
        invalidated = lambda candle: _c_get(candle, "close") < inv_level
    else:
        # bearish leg goes downward from sweep_extreme(high) to reclaim_close(low)
        # golden zone is a retrace upward from reclaim_close toward sweep_extreme
        gz_lo = reclaim_close + f1 * leg
        gz_hi = reclaim_close + f2 * leg
        inv_level = zone_top + cfg.invalidate_reclaim_buffer_atr_mult * atr
        in_zone = lambda price: (gz_lo <= price <= gz_hi)
        get_probe = lambda candle: _c_get(candle, "high")
        invalidated = lambda candle: _c_get(candle, "close") > inv_level

    # normalize range order
    lo = min(gz_lo, gz_hi)
    hi = max(gz_lo, gz_hi)

    end = min(len(candles) - 1, reclaim_index + cfg.golden_zone_max_bars)
    for i in range(reclaim_index + 1, end + 1):
        if invalidated(candles[i]):
            return {
                "hit": False,
                "range": (lo, hi),
                "hit_index": None,
                "score01": 0.0,
                "reason": "reclaim_invalidated_before_gz",
            }

        probe = get_probe(candles[i])
        if in_zone(probe):
            # score : plus c'est rapide, plus c'est fort
            bars = max(1, i - reclaim_index)
            speed = _clip01(1.0 - (bars - 1) / max(1, cfg.golden_zone_max_bars))
            return {
                "hit": True,
                "range": (lo, hi),
                "hit_index": i,
                "score01": speed,
            }

    return {"hit": False, "range": (lo, hi), "hit_index": None, "score01": 0.0}
