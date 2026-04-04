"""
core/pa_patterns/three_drives.py — Three Drives (3D) detector (IGNIS / HLZ)

3D (Three Drives) = 3 impulsions convergentes vers une zone, souvent signal PA le plus puissant.

Heuristique robuste (générique) :
- Bullish 3D (sur DEMAND) :
    • 3 "drives" baissiers successifs (swing lows) : L1 > L2 > L3
    • chaque drive démarre depuis un swing high précédent (H0->L1, H1->L2, H2->L3)
    • les longueurs des drives sont relativement similaires (symétrie) ou légèrement décroissantes
    • L3 est proche de la zone DEMAND
    • optionnel : rejet sur L3 (wick bas + close fort)

- Bearish 3D (sur SUPPLY) :
    • 3 drives haussiers successifs (swing highs) : H1 < H2 < H3
    • démarre depuis swing lows précédents (L0->H1, L1->H2, L2->H3)
    • H3 proche de la zone SUPPLY
    • rejet sur H3 (wick haut + close fort)

Design :
- Stateless
- Tolérant candles dict/obj (open/high/low/close)
- Zone optionnelle (mais recommandée). Si zone manquante : direction inférée par drift.

Sortie :
- ThreeDrivesResult(detected, direction, strength, third_drive_price, drive_points, details)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers (candles / zone) — tolérant
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


def _upper_wick(c: Any) -> float:
    o = _c_get(c, "open")
    cl = _c_get(c, "close")
    h = _c_get(c, "high")
    return max(0.0, h - max(o, cl))


def _lower_wick(c: Any) -> float:
    o = _c_get(c, "open")
    cl = _c_get(c, "close")
    l = _c_get(c, "low")
    return max(0.0, min(o, cl) - l)


def _close_strength(c: Any, direction: str) -> float:
    """
    0..1 close position in range.
    - bullish => close near high
    - bearish => close near low
    """
    h = _c_get(c, "high")
    l = _c_get(c, "low")
    cl = _c_get(c, "close")
    rng = max(1e-12, h - l)
    if direction == "BULLISH":
        return _clip01((cl - l) / rng)
    return _clip01((h - cl) / rng)


def _compute_atr(candles: list[Any], period: int = 14) -> float:
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
    if price > zone_top:
        return price - zone_top
    if price < zone_bot:
        return zone_bot - price
    return 0.0


def _infer_direction_from_zone(zone: Any, last_close: float) -> Optional[str]:
    """
    Returns trade-direction expected from zone:
      demand -> bullish
      supply -> bearish
    """
    zt = str(_z_get(zone, "zone_type", "") or _z_get(zone, "type", "") or _z_get(zone, "zoneType", "")).upper()
    if any(k in zt for k in ("DEMAND", "FLIPPY_D", "HIDDEN_D")):
        return "BULLISH"
    if any(k in zt for k in ("SUPPLY", "FLIPPY_S", "HIDDEN_S")):
        return "BEARISH"
    # fallback: if no type, infer by price vs zone mid (if bounds exist)
    top = _z_get(zone, "zone_top")
    bot = _z_get(zone, "zone_bot")
    if top is not None and bot is not None:
        zt2, zb2 = _normalize_zone_bounds(float(top), float(bot))
        mid = (zt2 + zb2) / 2
        return "BULLISH" if last_close <= mid else "BEARISH"
    return None


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class ThreeDrivesConfig:
    lookback: int = 320
    atr_period: int = 14

    # Swings
    swing_window: int = 2

    # Drives constraints
    min_drive_delta_atr_mult: float = 0.30     # min progression L1->L2->L3 (ou H1->H2->H3) par step (en ATR)
    max_drive_span_bars: int = 220             # pattern total span
    min_gap_between_drives: int = 4            # separation min between swing points
    max_gap_between_drives: int = 120          # separation max

    # Symmetry (drive length similarity)
    max_length_ratio: float = 1.35             # max_len / min_len <= 1.35
    allow_decreasing_lengths_bonus: bool = True

    # Zone proximity
    require_zone: bool = False
    proximity_atr_mult: float = 0.60
    proximity_pct: float = 0.006               # fallback if atr=0

    # Rejection on 3rd drive pivot candle (bonus)
    require_rejection: bool = False
    min_wick_to_body: float = 1.2
    min_wick_to_range: float = 0.40
    min_close_strength: float = 0.55

    # Scoring weights
    w_structure: float = 0.35
    w_symmetry: float = 0.25
    w_proximity: float = 0.20
    w_rejection: float = 0.15
    w_recency: float = 0.05


@dataclass
class ThreeDrivesResult:
    detected: bool = False
    direction: str = ""                  # "BULLISH" | "BEARISH" (expected reaction)
    strength: int = 0                    # 0..100

    third_drive_price: Optional[float] = None
    third_drive_index: Optional[int] = None

    # each drive: {"start_index","start_price","end_index","end_price","length","length_atr"}
    drive_points: list[dict[str, Any]] = field(default_factory=list)

    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None
    distance_to_zone: Optional[float] = None
    atr: Optional[float] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class ThreeDrivesDetector:
    """
    Détecteur Three Drives.
    """

    def __init__(self, config: Optional[ThreeDrivesConfig] = None) -> None:
        self.config = config or ThreeDrivesConfig()

    def detect(self, candles: list[Any], zone: Optional[Any] = None) -> ThreeDrivesResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 80):
            return ThreeDrivesResult(detected=False, details={"reason": "not_enough_candles"})

        if cfg.require_zone and zone is None:
            return ThreeDrivesResult(detected=False, details={"reason": "zone_required"})

        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            atr = 0.0

        last_close = _c_get(candles[-1], "close")

        # Zone bounds
        zone_top = zone_bot = None
        direction = None
        if zone is not None:
            zt = _z_get(zone, "zone_top")
            zb = _z_get(zone, "zone_bot")
            if zt is not None and zb is not None:
                zone_top, zone_bot = _normalize_zone_bounds(float(zt), float(zb))
            direction = _infer_direction_from_zone(zone, last_close)

        if direction is None:
            # fallback: infer by drift (last 20 bars)
            direction = "BULLISH" if _c_get(c[-1], "close") >= _c_get(c[max(0, len(c) - 20)], "open") else "BEARISH"

        # Swings
        swings_hi, swings_lo = _find_swings(c, window=cfg.swing_window)

        # Scan for best pattern (most recent / strongest)
        best: Optional[ThreeDrivesResult] = None
        best_strength = 0

        if direction == "BULLISH":
            candidates = _find_bullish_3drives_candidates(
                candles=c,
                swings_hi=swings_hi,
                swings_lo=swings_lo,
                atr=atr,
                cfg=cfg,
            )
        else:
            candidates = _find_bearish_3drives_candidates(
                candles=c,
                swings_hi=swings_hi,
                swings_lo=swings_lo,
                atr=atr,
                cfg=cfg,
            )

        for cand in candidates:
            # proximity to zone (optional)
            prox_ok = True
            prox_score01 = 0.5
            dist_to_zone = None

            third_price = cand["third_price"]
            third_idx = cand["third_end_index"]

            if zone_top is not None and zone_bot is not None:
                dist_to_zone = _distance_to_zone(third_price, zone_top, zone_bot)

                if atr > 0:
                    prox_ok = dist_to_zone <= cfg.proximity_atr_mult * atr
                    prox_score01 = _clip01(1.0 - dist_to_zone / max(1e-12, cfg.proximity_atr_mult * atr))
                else:
                    mid = (zone_top + zone_bot) / 2
                    pct = abs(third_price - mid) / max(1e-12, mid)
                    prox_ok = pct <= cfg.proximity_pct
                    prox_score01 = _clip01(1.0 - pct / max(1e-12, cfg.proximity_pct))

                if cfg.require_zone and not prox_ok:
                    continue

            # rejection score on pivot candle
            rejection_ok = True
            rejection_score01 = 0.5
            rejection_meta: dict[str, Any] = {"enabled": cfg.require_rejection}

            pivot_candle = c[third_idx]
            if direction == "BULLISH":
                wick = _lower_wick(pivot_candle)
                opp_wick = _upper_wick(pivot_candle)
                cs = _close_strength(pivot_candle, "BULLISH")
            else:
                wick = _upper_wick(pivot_candle)
                opp_wick = _lower_wick(pivot_candle)
                cs = _close_strength(pivot_candle, "BEARISH")

            rng = max(1e-12, _range(pivot_candle))
            bdy = max(1e-12, _body(pivot_candle))
            wick_to_body = wick / bdy
            wick_to_range = wick / rng

            rej_ok = (
                wick_to_body >= cfg.min_wick_to_body
                and wick_to_range >= cfg.min_wick_to_range
                and cs >= cfg.min_close_strength
            )
            rejection_ok = rej_ok if cfg.require_rejection else True
            if cfg.require_rejection and not rej_ok:
                continue

            wick_score = _clip01(
                0.5 * (wick_to_body / max(1e-12, cfg.min_wick_to_body) - 1.0)
                + 0.5 * (wick_to_range / max(1e-12, cfg.min_wick_to_range) - 1.0)
            )
            close_score = _clip01((cs - cfg.min_close_strength) / max(1e-12, (1.0 - cfg.min_close_strength)))
            rejection_score01 = _clip01(0.60 * wick_score + 0.40 * close_score)
            rejection_meta.update({
                "ok": rej_ok,
                "wick_to_body": round(wick_to_body, 3),
                "wick_to_range": round(wick_to_range, 3),
                "close_strength": round(cs, 3),
                "score01": round(rejection_score01, 3),
                "opp_wick": round(opp_wick, 6),
            })

            # structure score (monotonic drives progression)
            structure_score01 = cand["structure_score01"]
            symmetry_score01 = cand["symmetry_score01"]

            # recency score: third drive near end of series
            age_bars = (len(c) - 1) - third_idx
            recency_score01 = _clip01(1.0 - age_bars / 80.0)

            total01 = (
                cfg.w_structure * structure_score01
                + cfg.w_symmetry * symmetry_score01
                + cfg.w_proximity * prox_score01
                + cfg.w_rejection * rejection_score01
                + cfg.w_recency * recency_score01
            )
            strength = int(round(100 * _clip01(total01)))

            if strength >= best_strength:
                best_strength = strength
                best = ThreeDrivesResult(
                    detected=True,
                    direction=direction,
                    strength=strength,
                    third_drive_price=float(third_price),
                    third_drive_index=offset + third_idx,
                    drive_points=[
                        {
                            "start_index": offset + d["start_index"],
                            "start_price": float(d["start_price"]),
                            "end_index": offset + d["end_index"],
                            "end_price": float(d["end_price"]),
                            "length": float(d["length"]),
                            "length_atr": float(d["length_atr"]) if d["length_atr"] is not None else None,
                        }
                        for d in cand["drives"]
                    ],
                    zone_top=float(zone_top) if zone_top is not None else None,
                    zone_bot=float(zone_bot) if zone_bot is not None else None,
                    distance_to_zone=float(dist_to_zone) if dist_to_zone is not None else None,
                    atr=float(atr),
                    details={
                        "scores01": {
                            "structure": round(structure_score01, 3),
                            "symmetry": round(symmetry_score01, 3),
                            "proximity": round(prox_score01, 3),
                            "rejection": round(rejection_score01, 3),
                            "recency": round(recency_score01, 3),
                            "total01": round(_clip01(total01), 3),
                        },
                        "cand": cand,
                        "rejection": rejection_meta,
                        "age_bars": age_bars,
                    },
                )

        if best is None:
            return ThreeDrivesResult(
                detected=False,
                direction=direction,
                atr=float(atr),
                zone_top=float(zone_top) if zone_top is not None else None,
                zone_bot=float(zone_bot) if zone_bot is not None else None,
                details={"reason": "no_three_drives_found"},
            )

        return best


# ═════════════════════════════════════════════════════════════════════════════=
# Internals — swings & candidates
# ═════════════════════════════════════════════════════════════════════════════=

def _find_swings(candles: list[Any], window: int = 2) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
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


def _length_similarity_score(lengths: list[float], max_ratio: float) -> float:
    if not lengths or any(l <= 0 for l in lengths):
        return 0.0
    mn = min(lengths)
    mx = max(lengths)
    ratio = mx / max(1e-12, mn)
    # score 1 when ratio <= 1.05, 0 when ratio >= max_ratio
    if ratio <= 1.05:
        return 1.0
    if ratio >= max_ratio:
        return 0.0
    return _clip01(1.0 - (ratio - 1.05) / max(1e-12, (max_ratio - 1.05)))


def _find_prev_swing(
    swings: list[tuple[int, float]],
    *,
    before_index: int,
    after_index: Optional[int] = None,
) -> Optional[tuple[int, float]]:
    """
    Return latest swing with idx < before_index and (if after_index given) idx > after_index.
    """
    for idx, price in reversed(swings):
        if idx < before_index and (after_index is None or idx > after_index):
            return idx, price
    return None


def _find_bullish_3drives_candidates(
    *,
    candles: list[Any],
    swings_hi: list[tuple[int, float]],
    swings_lo: list[tuple[int, float]],
    atr: float,
    cfg: ThreeDrivesConfig,
) -> list[dict[str, Any]]:
    """
    Bullish 3 drives:
      H0->L1, H1->L2, H2->L3 with L1 > L2 > L3
    """
    if len(swings_lo) < 3 or len(swings_hi) < 3:
        return []

    out: list[dict[str, Any]] = []

    step_min = cfg.min_drive_delta_atr_mult * atr if atr > 0 else 0.0

    # take last few lows as potential L3
    lows_tail = swings_lo[-10:]
    for i3, l3 in reversed(lows_tail):
        # get previous low L2 and L1
        prev2 = _find_prev_swing(swings_lo, before_index=i3)
        if prev2 is None:
            continue
        i2, l2 = prev2
        prev1 = _find_prev_swing(swings_lo, before_index=i2)
        if prev1 is None:
            continue
        i1, l1 = prev1

        # spacing constraints
        if (i2 - i1) < cfg.min_gap_between_drives or (i3 - i2) < cfg.min_gap_between_drives:
            continue
        if (i2 - i1) > cfg.max_gap_between_drives or (i3 - i2) > cfg.max_gap_between_drives:
            continue

        # monotonic lows
        if not (l1 > l2 > l3):
            continue
        if (l1 - l2) < step_min or (l2 - l3) < step_min:
            continue

        # find highs preceding each low (within segments)
        h0 = _find_prev_swing(swings_hi, before_index=i1)
        h1 = _find_prev_swing(swings_hi, before_index=i2, after_index=i1)
        h2 = _find_prev_swing(swings_hi, before_index=i3, after_index=i2)

        if h0 is None or h1 is None or h2 is None:
            continue

        (h0i, h0p), (h1i, h1p), (h2i, h2p) = h0, h1, h2

        # lengths of each drive
        d1 = max(0.0, h0p - l1)
        d2 = max(0.0, h1p - l2)
        d3 = max(0.0, h2p - l3)
        if d1 <= 0 or d2 <= 0 or d3 <= 0:
            continue

        # similarity
        symmetry_score01 = _length_similarity_score([d1, d2, d3], cfg.max_length_ratio)
        if symmetry_score01 <= 0:
            continue

        # structure quality: highs ideally also descending (compression) but not mandatory
        high_ok = (h0p >= h1p >= h2p)
        structure_score01 = 0.85 if high_ok else 0.65

        # bonus if decreasing lengths
        if cfg.allow_decreasing_lengths_bonus and (d1 >= d2 >= d3):
            symmetry_score01 = _clip01(symmetry_score01 + 0.10)

        # span constraint
        if (i3 - h0i) > cfg.max_drive_span_bars:
            continue

        out.append({
            "third_end_index": i3,
            "third_price": l3,
            "drives": [
                {"start_index": h0i, "start_price": h0p, "end_index": i1, "end_price": l1, "length": d1, "length_atr": (d1 / atr) if atr > 0 else None},
                {"start_index": h1i, "start_price": h1p, "end_index": i2, "end_price": l2, "length": d2, "length_atr": (d2 / atr) if atr > 0 else None},
                {"start_index": h2i, "start_price": h2p, "end_index": i3, "end_price": l3, "length": d3, "length_atr": (d3 / atr) if atr > 0 else None},
            ],
            "structure_score01": structure_score01,
            "symmetry_score01": symmetry_score01,
            "meta": {
                "lows": [(i1, l1), (i2, l2), (i3, l3)],
                "highs": [(h0i, h0p), (h1i, h1p), (h2i, h2p)],
                "high_descending": high_ok,
            },
        })

    # prefer most recent first
    out.sort(key=lambda x: x["third_end_index"], reverse=True)
    return out


def _find_bearish_3drives_candidates(
    *,
    candles: list[Any],
    swings_hi: list[tuple[int, float]],
    swings_lo: list[tuple[int, float]],
    atr: float,
    cfg: ThreeDrivesConfig,
) -> list[dict[str, Any]]:
    """
    Bearish 3 drives:
      L0->H1, L1->H2, L2->H3 with H1 < H2 < H3
    """
    if len(swings_hi) < 3 or len(swings_lo) < 3:
        return []

    out: list[dict[str, Any]] = []

    step_min = cfg.min_drive_delta_atr_mult * atr if atr > 0 else 0.0

    highs_tail = swings_hi[-10:]
    for i3, h3 in reversed(highs_tail):
        prev2 = _find_prev_swing(swings_hi, before_index=i3)
        if prev2 is None:
            continue
        i2, h2 = prev2
        prev1 = _find_prev_swing(swings_hi, before_index=i2)
        if prev1 is None:
            continue
        i1, h1 = prev1

        if (i2 - i1) < cfg.min_gap_between_drives or (i3 - i2) < cfg.min_gap_between_drives:
            continue
        if (i2 - i1) > cfg.max_gap_between_drives or (i3 - i2) > cfg.max_gap_between_drives:
            continue

        if not (h1 < h2 < h3):
            continue
        if (h2 - h1) < step_min or (h3 - h2) < step_min:
            continue

        # find lows preceding each high
        l0 = _find_prev_swing(swings_lo, before_index=i1)
        l1 = _find_prev_swing(swings_lo, before_index=i2, after_index=i1)
        l2 = _find_prev_swing(swings_lo, before_index=i3, after_index=i2)

        if l0 is None or l1 is None or l2 is None:
            continue

        (l0i, l0p), (l1i, l1p), (l2i, l2p) = l0, l1, l2

        d1 = max(0.0, h1 - l0p)
        d2 = max(0.0, h2 - l1p)
        d3 = max(0.0, h3 - l2p)
        if d1 <= 0 or d2 <= 0 or d3 <= 0:
            continue

        symmetry_score01 = _length_similarity_score([d1, d2, d3], cfg.max_length_ratio)
        if symmetry_score01 <= 0:
            continue

        # structure quality: lows ideally ascending
        low_ok = (l0p <= l1p <= l2p)
        structure_score01 = 0.85 if low_ok else 0.65

        if cfg.allow_decreasing_lengths_bonus and (d1 >= d2 >= d3):
            symmetry_score01 = _clip01(symmetry_score01 + 0.10)

        if (i3 - l0i) > cfg.max_drive_span_bars:
            continue

        out.append({
            "third_end_index": i3,
            "third_price": h3,
            "drives": [
                {"start_index": l0i, "start_price": l0p, "end_index": i1, "end_price": h1, "length": d1, "length_atr": (d1 / atr) if atr > 0 else None},
                {"start_index": l1i, "start_price": l1p, "end_index": i2, "end_price": h2, "length": d2, "length_atr": (d2 / atr) if atr > 0 else None},
                {"start_index": l2i, "start_price": l2p, "end_index": i3, "end_price": h3, "length": d3, "length_atr": (d3 / atr) if atr > 0 else None},
            ],
            "structure_score01": structure_score01,
            "symmetry_score01": symmetry_score01,
            "meta": {
                "highs": [(i1, h1), (i2, h2), (i3, h3)],
                "lows": [(l0i, l0p), (l1i, l1p), (l2i, l2p)],
                "low_ascending": low_ok,
            },
        })

    out.sort(key=lambda x: x["third_end_index"], reverse=True)
    return out
