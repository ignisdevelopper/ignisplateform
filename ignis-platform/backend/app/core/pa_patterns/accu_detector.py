"""
core/pa_patterns/accu_detector.py — ACCU (Accumulation / "escalier") detector (IGNIS / HLZ)

ACCU (Price Approaching pattern) :
- Pattern d’approche d’une zone S&D (SGB) via une compression en "escaliers".
- Heuristique robuste (générique) :
  • Approche UP vers une zone (prix sous la zone)  -> Higher Lows (HL) successifs
  • Approche DOWN vers une zone (prix au-dessus)   -> Lower Highs (LH) successifs
  • Optionnel : structure en wedge (opposite swings "plats" ou convergents)
  • Derniers points proches de la zone (proximité)

Design :
- Stateless
- Tolérant : candles dict/obj (open/high/low/close)
- Zone optionnelle mais fortement recommandée (zone_top/zone_bot/zone_type)

Output :
- AccuResult : detected + direction(approach) + strength(0..100) + steps + indices + details
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


def _normalize_zone_bounds(zone_top: float, zone_bot: float) -> tuple[float, float]:
    zt = float(zone_top)
    zb = float(zone_bot)
    return (zt, zb) if zt >= zb else (zb, zt)


def _distance_to_zone(price: float, zone_top: float, zone_bot: float) -> float:
    """Distance au plus proche bord de zone (0 si dans la zone)."""
    if price > zone_top:
        return price - zone_top
    if price < zone_bot:
        return zone_bot - price
    return 0.0


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class AccuConfig:
    lookback: int = 220
    atr_period: int = 14

    # Swings (fractal)
    swing_window: int = 2

    # Staircase constraints
    min_steps: int = 3
    max_steps: int = 7
    min_step_delta_atr_mult: float = 0.12      # delta minimal entre swings successifs (en ATR)
    max_span_bars: int = 160                   # nombre de bougies max couvert par le pattern
    max_gap_between_steps: int = 80            # gap max entre 2 swings du staircase

    # Wedge / convergence (optional but boosts score)
    require_opposite_swings: bool = False      # si True, exige une convergence (wedge)
    opposite_swings_window: int = 2            # nb de swings opposés à trouver dans le segment

    # Proximity to zone
    require_zone: bool = True
    proximity_atr_mult: float = 0.50           # dernier swing doit être à <= X*ATR de la zone
    proximity_pct: float = 0.004               # fallback si atr=0

    # Scoring weights
    w_steps: float = 0.35
    w_monotonic: float = 0.25
    w_proximity: float = 0.25
    w_wedge: float = 0.15


@dataclass
class AccuResult:
    detected: bool = False

    # direction = direction d’approche vers la zone (et non la direction du trade)
    # UP   : prix monte vers une zone au-dessus (Higher Lows)
    # DOWN : prix descend vers une zone en-dessous (Lower Highs)
    direction: str = ""                 # "UP" | "DOWN"
    strength: int = 0                   # 0..100

    steps: int = 0
    step_kind: str = ""                 # "HL" (higher lows) | "LH" (lower highs)

    accu_start_index: Optional[int] = None
    accu_end_index: Optional[int] = None
    step_points: list[dict[str, Any]] = field(default_factory=list)

    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None
    distance_to_zone: Optional[float] = None
    atr: Optional[float] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class AccuDetector:
    """
    Détecteur ACCU.

    Usage typique :
        res = AccuDetector().detect(candles, zone=zone)
        if res.detected: ...
    """

    def __init__(self, config: Optional[AccuConfig] = None) -> None:
        self.config = config or AccuConfig()

    def detect(self, candles: list[Any], zone: Optional[Any] = None) -> AccuResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 60):
            return AccuResult(detected=False, details={"reason": "not_enough_candles"})

        if cfg.require_zone and zone is None:
            return AccuResult(detected=False, details={"reason": "zone_required"})

        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            atr = 0.0

        # Zone bounds
        zone_top = zone_bot = None
        if zone is not None:
            zt = _z_get(zone, "zone_top")
            zb = _z_get(zone, "zone_bot")
            if zt is None or zb is None:
                if cfg.require_zone:
                    return AccuResult(detected=False, details={"reason": "zone_missing_bounds"})
            else:
                zone_top, zone_bot = _normalize_zone_bounds(float(zt), float(zb))

        last_close = _c_get(candles[-1], "close")

        # Determine approach direction using zone position if available
        if zone_top is not None and zone_bot is not None:
            if last_close < zone_bot:
                approach_dir = "UP"     # price is below zone -> approaching upward
            elif last_close > zone_top:
                approach_dir = "DOWN"   # price is above zone -> approaching downward
            else:
                # already inside zone: infer from last swing drift
                approach_dir = _infer_direction_from_recent_drift(c)
        else:
            approach_dir = _infer_direction_from_recent_drift(c)

        # Swings
        swings_hi, swings_lo = _find_swings(c, window=cfg.swing_window)

        # For UP approach => higher lows staircase (use swing lows)
        # For DOWN approach => lower highs staircase (use swing highs)
        if approach_dir == "UP":
            step_kind = "HL"
            staircase = _extract_monotone_tail(
                swings=swings_lo,
                mode="increasing",
                atr=atr,
                min_steps=cfg.min_steps,
                max_steps=cfg.max_steps,
                min_step_delta_atr_mult=cfg.min_step_delta_atr_mult,
                max_gap=cfg.max_gap_between_steps,
            )
        else:
            step_kind = "LH"
            staircase = _extract_monotone_tail(
                swings=swings_hi,
                mode="decreasing",
                atr=atr,
                min_steps=cfg.min_steps,
                max_steps=cfg.max_steps,
                min_step_delta_atr_mult=cfg.min_step_delta_atr_mult,
                max_gap=cfg.max_gap_between_steps,
            )

        if staircase is None:
            return AccuResult(
                detected=False,
                direction=approach_dir,
                step_kind=step_kind,
                atr=float(atr),
                zone_top=zone_top,
                zone_bot=zone_bot,
                details={"reason": "no_staircase"},
            )

        step_indices, step_prices = staircase
        steps = len(step_indices)
        accu_start = step_indices[0]
        accu_end = step_indices[-1]

        # Span filter
        if (accu_end - accu_start) > cfg.max_span_bars:
            return AccuResult(
                detected=False,
                direction=approach_dir,
                step_kind=step_kind,
                steps=steps,
                atr=float(atr),
                zone_top=zone_top,
                zone_bot=zone_bot,
                details={"reason": "span_too_large", "span": (accu_end - accu_start), "max": cfg.max_span_bars},
            )

        # Proximity to zone filter
        prox_ok = True
        dist_to_zone = None
        prox_score01 = 0.5

        if zone_top is not None and zone_bot is not None:
            last_step_price = step_prices[-1]
            # distance of last step to nearest boundary in direction of approach
            if approach_dir == "UP":
                dist_to_zone = abs(zone_bot - last_step_price) if last_step_price < zone_bot else 0.0
            else:
                dist_to_zone = abs(last_step_price - zone_top) if last_step_price > zone_top else 0.0

            if atr > 0:
                prox_ok = dist_to_zone <= cfg.proximity_atr_mult * atr
                prox_score01 = _clip01(1.0 - dist_to_zone / max(1e-12, cfg.proximity_atr_mult * atr))
            else:
                # pct fallback
                ref = zone_bot if approach_dir == "UP" else zone_top
                pct = abs(last_step_price - ref) / max(1e-12, ref)
                prox_ok = pct <= cfg.proximity_pct
                prox_score01 = _clip01(1.0 - pct / max(1e-12, cfg.proximity_pct))

            if not prox_ok:
                return AccuResult(
                    detected=False,
                    direction=approach_dir,
                    step_kind=step_kind,
                    steps=steps,
                    atr=float(atr),
                    zone_top=zone_top,
                    zone_bot=zone_bot,
                    distance_to_zone=float(dist_to_zone),
                    details={
                        "reason": "not_close_to_zone",
                        "distance_to_zone": dist_to_zone,
                        "atr": atr,
                        "proximity_atr_mult": cfg.proximity_atr_mult,
                    },
                )

        # Wedge / convergence score (optional)
        wedge_ok, wedge_score01, wedge_meta = _wedge_convergence_score(
            swings_hi=swings_hi,
            swings_lo=swings_lo,
            segment_start=accu_start,
            segment_end=accu_end,
            approach_dir=approach_dir,
            atr=atr,
            cfg=cfg,
        )
        if cfg.require_opposite_swings and not wedge_ok:
            return AccuResult(
                detected=False,
                direction=approach_dir,
                step_kind=step_kind,
                steps=steps,
                atr=float(atr),
                zone_top=zone_top,
                zone_bot=zone_bot,
                details={"reason": "no_wedge_convergence", **wedge_meta},
            )

        # Monotonic quality score
        mono_score01 = _monotonic_quality(step_prices, mode=("increasing" if approach_dir == "UP" else "decreasing"), atr=atr)

        # Steps score
        steps_score01 = _clip01((steps - cfg.min_steps) / max(1e-9, (cfg.max_steps - cfg.min_steps)))

        # Final score
        score01 = (
            cfg.w_steps * steps_score01
            + cfg.w_monotonic * mono_score01
            + cfg.w_proximity * prox_score01
            + cfg.w_wedge * wedge_score01
        )
        strength = int(round(100 * _clip01(score01)))

        return AccuResult(
            detected=True,
            direction=approach_dir,
            strength=strength,
            steps=steps,
            step_kind=step_kind,
            accu_start_index=offset + accu_start,
            accu_end_index=offset + accu_end,
            step_points=[
                {"index": offset + i, "price": float(p)}
                for i, p in zip(step_indices, step_prices)
            ],
            zone_top=float(zone_top) if zone_top is not None else None,
            zone_bot=float(zone_bot) if zone_bot is not None else None,
            distance_to_zone=float(dist_to_zone) if dist_to_zone is not None else None,
            atr=float(atr),
            details={
                "scores01": {
                    "steps": round(steps_score01, 3),
                    "monotonic": round(mono_score01, 3),
                    "proximity": round(prox_score01, 3),
                    "wedge": round(wedge_score01, 3),
                    "total01": round(_clip01(score01), 3),
                },
                "wedge": wedge_meta,
                "segment": {"start": offset + accu_start, "end": offset + accu_end, "span": accu_end - accu_start},
            },
        )


# ═════════════════════════════════════════════════════════════════════════════=
# Internals
# ═════════════════════════════════════════════════════════════════════════════=

def _infer_direction_from_recent_drift(candles: list[Any]) -> str:
    """Fallback direction when zone is absent/ambiguous."""
    if len(candles) < 10:
        return "UP"
    o0 = _c_get(candles[-10], "open")
    cN = _c_get(candles[-1], "close")
    return "UP" if cN >= o0 else "DOWN"


def _find_swings(candles: list[Any], window: int = 2) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    """
    Fractal swings simples :
      swing high : high[i] > highs des window bougies avant et après
      swing low  : low[i]  < lows  des window bougies avant et après
    """
    highs: list[tuple[int, float]] = []
    lows: list[tuple[int, float]] = []
    n = len(candles)
    w = max(1, int(window))

    for i in range(w, n - w):
        hi = _c_get(candles[i], "high")
        lo = _c_get(candles[i], "low")

        before_hi = [_c_get(candles[j], "high") for j in range(i - w, i)]
        after_hi = [_c_get(candles[j], "high") for j in range(i + 1, i + w + 1)]
        if hi > max(before_hi) and hi > max(after_hi):
            highs.append((i, hi))

        before_lo = [_c_get(candles[j], "low") for j in range(i - w, i)]
        after_lo = [_c_get(candles[j], "low") for j in range(i + 1, i + w + 1)]
        if lo < min(before_lo) and lo < min(after_lo):
            lows.append((i, lo))

    return highs, lows


def _extract_monotone_tail(
    *,
    swings: list[tuple[int, float]],
    mode: str,  # "increasing" | "decreasing"
    atr: float,
    min_steps: int,
    max_steps: int,
    min_step_delta_atr_mult: float,
    max_gap: int,
) -> Optional[tuple[list[int], list[float]]]:
    """
    Extrait la suite monotone la plus récente (tail) dans la liste de swings.
    - increasing : prix strictement croissants (HL)
    - decreasing : prix strictement décroissants (LH)
    """
    if len(swings) < min_steps:
        return None

    # On prend les swings les plus récents, en laissant un peu de marge
    recent = swings[-(max_steps + 5) :]

    run_idx: list[int] = []
    run_val: list[float] = []

    step_min = (min_step_delta_atr_mult * atr) if (atr and atr > 0) else 0.0

    # build from most recent backwards
    for k in range(len(recent) - 1, -1, -1):
        i, p = recent[k]
        if not run_val:
            run_idx.append(i)
            run_val.append(p)
            continue

        prev_i = run_idx[-1]
        prev_p = run_val[-1]

        # gap constraint (time)
        if (prev_i - i) > max_gap:
            break

        if mode == "increasing":
            ok = p < (prev_p - step_min)  # older must be lower than newer (when going backwards)
        else:
            ok = p > (prev_p + step_min)  # older must be higher than newer

        if not ok:
            break

        run_idx.append(i)
        run_val.append(p)

        if len(run_idx) >= max_steps:
            break

    if len(run_idx) < min_steps:
        return None

    # reverse to chronological
    run_idx = list(reversed(run_idx))
    run_val = list(reversed(run_val))
    return run_idx, run_val


def _monotonic_quality(prices: list[float], *, mode: str, atr: float) -> float:
    """
    Score 0..1 : mesure à quel point la progression est propre (pas de micro-violations).
    On score la régularité des deltas.
    """
    if len(prices) < 2:
        return 0.0

    deltas = []
    for i in range(1, len(prices)):
        deltas.append(prices[i] - prices[i - 1])

    # expected sign
    if mode == "increasing":
        good = [d for d in deltas if d > 0]
    else:
        good = [d for d in deltas if d < 0]

    sign_score = len(good) / len(deltas)

    # regularity: deltas similar size (low variance proxy)
    absd = [abs(d) for d in deltas]
    mean = sum(absd) / len(absd)
    if mean <= 1e-12:
        return 0.0

    # average deviation normalized
    dev = sum(abs(x - mean) for x in absd) / len(absd)
    reg_score = _clip01(1.0 - dev / mean)

    # normalize amplitude vs ATR (bonus if meaningful)
    amp = abs(prices[-1] - prices[0])
    amp_score = _clip01((amp / atr) / 1.5) if (atr and atr > 0) else 0.5

    return _clip01(0.45 * sign_score + 0.35 * reg_score + 0.20 * amp_score)


def _wedge_convergence_score(
    *,
    swings_hi: list[tuple[int, float]],
    swings_lo: list[tuple[int, float]],
    segment_start: int,
    segment_end: int,
    approach_dir: str,
    atr: float,
    cfg: AccuConfig,
) -> tuple[bool, float, dict[str, Any]]:
    """
    Convergence proxy :
    - approach UP (HLs): on aime que les swing highs dans le segment soient plats/décroissants
    - approach DOWN (LHs): on aime que les swing lows dans le segment soient plats/croissants
    """
    # extract opposite swings inside segment
    if approach_dir == "UP":
        opp = [(i, p) for i, p in swings_hi if segment_start <= i <= segment_end]
        expected = "flat_or_down"
    else:
        opp = [(i, p) for i, p in swings_lo if segment_start <= i <= segment_end]
        expected = "flat_or_up"

    meta = {
        "expected": expected,
        "opp_count": len(opp),
        "opp_swings": opp[-5:],
    }

    if len(opp) < cfg.opposite_swings_window:
        return False, 0.0, {**meta, "ok": False, "reason": "not_enough_opposite_swings"}

    # take last 2 opposite swings to estimate slope
    (i1, p1), (i2, p2) = opp[-2], opp[-1]
    if i2 == i1:
        return False, 0.0, {**meta, "ok": False, "reason": "duplicate_indices"}

    slope = (p2 - p1) / (i2 - i1)

    # For UP approach, we want highs not rising (slope <= 0)
    # For DOWN approach, we want lows not falling (slope >= 0)
    ok = (slope <= 0) if approach_dir == "UP" else (slope >= 0)

    # score: if slope is in desired direction -> 0.7..1, else -> 0..0.4
    # normalize by ATR to be scale-independent
    slope_atr = (abs(slope) / atr) if (atr and atr > 0) else 0.0

    if ok:
        score01 = _clip01(0.75 + 0.25 * _clip01(1.0 - slope_atr / 0.05))  # smaller slope => better
    else:
        score01 = _clip01(0.35 * _clip01(1.0 - slope_atr / 0.05))

    return ok, score01, {
        **meta,
        "ok": ok,
        "slope": slope,
        "slope_atr": round(slope_atr, 6),
        "score01": round(score01, 3),
    }
