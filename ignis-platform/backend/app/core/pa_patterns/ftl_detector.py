"""
core/pa_patterns/ftl_detector.py — FTL (Flip Trend Line) detector (IGNIS / HLZ)

FTL = Flip Trend Line :
- Une trendline est cassée (break).
- Puis le prix revient la retester (pullback).
- La ligne "flip" en support/résistance et le marché rejette dans le sens du break.

Définitions (heuristique robuste) :
- Bullish FTL :
    1) Downtrend line construite sur 2 swing highs descendants
    2) Break : close au-dessus de la ligne (+ buffer)
    3) Retest : low touche la ligne (tolérance) et close repasse au-dessus (rejet)
- Bearish FTL :
    1) Uptrend line construite sur 2 swing lows ascendants
    2) Break : close sous la ligne (- buffer)
    3) Retest : high touche la ligne et close repasse sous (rejet)

Design :
- Stateless
- Tolérant : candles dict/obj (open/high/low/close)
- Zone optionnelle : boost score si le FTL se produit proche d'une zone S&D

Sortie :
- FTLResult(detected, status, direction, strength, pivots, break/retest, line)
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


def _line_value_at(x1: int, y1: float, x2: int, y2: float, x: int) -> Optional[float]:
    if x2 == x1:
        return None
    m = (y2 - y1) / (x2 - x1)
    return y1 + m * (x - x1)


def _distance_to_line(price: float, line: float) -> float:
    return abs(price - line)


def _intersects_band(high: float, low: float, level: float, tol: float) -> bool:
    """True si le range [low,high] touche la bande [level-tol, level+tol]."""
    return not (high < (level - tol) or low > (level + tol))


def _zone_mid(zone_top: float, zone_bot: float) -> float:
    return (zone_top + zone_bot) / 2.0


def _distance_to_zone(price: float, zone_top: float, zone_bot: float) -> float:
    if price > zone_top:
        return price - zone_top
    if price < zone_bot:
        return zone_bot - price
    return 0.0


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class FTLConfig:
    lookback: int = 260
    atr_period: int = 14

    # Swings
    swing_window: int = 2
    min_pivot_spacing: int = 4          # minimum bars between pivots to avoid micro-noise
    max_pivot_age_bars: int = 140       # pivots must be recent enough

    # Break validation
    break_buffer_atr_mult: float = 0.10
    require_close_break: bool = True
    min_break_body_to_range: float = 0.12
    min_break_close_strength: float = 0.55

    # Retest (flip) validation
    retest_max_bars: int = 18
    retest_tolerance_atr_mult: float = 0.20   # distance max au niveau de ligne pour considérer "touch"
    require_retest_rejection: bool = True
    min_retest_wick_to_body: float = 1.0
    min_retest_wick_to_range: float = 0.35
    min_retest_close_strength: float = 0.55

    # Optional confluence with zone (boost score)
    zone_boost_enabled: bool = True
    zone_proximity_atr_mult: float = 0.75

    # Output
    allow_forming: bool = True  # si break détecté mais retest pas encore => status FORMING

    # Scoring weights (0..1)
    w_break: float = 0.40
    w_retest: float = 0.40
    w_recency: float = 0.10
    w_zone: float = 0.10


@dataclass
class FTLResult:
    detected: bool = False
    status: str = ""                 # "FORMING" | "CONFIRMED"
    direction: str = ""              # "BULLISH" | "BEARISH"
    strength: int = 0                # 0..100

    # Trendline pivots
    pivot1_index: Optional[int] = None
    pivot1_price: Optional[float] = None
    pivot2_index: Optional[int] = None
    pivot2_price: Optional[float] = None

    # Break & retest
    break_index: Optional[int] = None
    break_close: Optional[float] = None
    retest_index: Optional[int] = None
    retest_close: Optional[float] = None

    # Line value at key points
    line_at_break: Optional[float] = None
    line_at_retest: Optional[float] = None

    atr: Optional[float] = None
    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None
    zone_distance: Optional[float] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class FTLDetector:
    """
    Détecte un FTL bullish/bearish.
    """

    def __init__(self, config: Optional[FTLConfig] = None) -> None:
        self.config = config or FTLConfig()

    def detect(self, candles: list[Any], zone: Optional[Any] = None) -> FTLResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 80):
            return FTLResult(detected=False, details={"reason": "not_enough_candles"})

        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            atr = 0.0

        # Zone optional
        zone_top = zone_bot = None
        zone_dist = None
        if zone is not None:
            zt = _z_get(zone, "zone_top")
            zb = _z_get(zone, "zone_bot")
            if zt is not None and zb is not None:
                zone_top = float(zt)
                zone_bot = float(zb)
                if zone_top < zone_bot:
                    zone_top, zone_bot = zone_bot, zone_top

        # Swings
        swings_hi, swings_lo = _find_swings(c, window=cfg.swing_window)

        # Candidate lines:
        # - Bullish: last two swing highs descending (downtrendline)
        # - Bearish: last two swing lows ascending (uptrendline)
        bull = self._detect_bullish_ftl(c, swings_hi, atr, cfg, offset, zone_top, zone_bot)
        bear = self._detect_bearish_ftl(c, swings_lo, atr, cfg, offset, zone_top, zone_bot)

        # Choose best
        candidates = [x for x in (bull, bear) if x.detected]
        if not candidates:
            # still allow FORMING return? We embed in detected=True only when break exists.
            forming_candidates = [x for x in (bull, bear) if (x.status == "FORMING" and x.detected)]
            return forming_candidates[0] if forming_candidates else FTLResult(
                detected=False,
                atr=float(atr),
                zone_top=zone_top,
                zone_bot=zone_bot,
                details={"reason": "no_ftl"},
            )

        candidates.sort(key=lambda r: r.strength, reverse=True)
        return candidates[0]

    # ──────────────────────────────────────────────────────────────────────
    # Bullish FTL
    # ──────────────────────────────────────────────────────────────────────

    def _detect_bullish_ftl(
        self,
        candles: list[Any],
        swings_high: list[tuple[int, float]],
        atr: float,
        cfg: FTLConfig,
        offset: int,
        zone_top: Optional[float],
        zone_bot: Optional[float],
    ) -> FTLResult:
        if len(swings_high) < 2:
            return FTLResult(detected=False)

        # pick last suitable pivot pair (most recent, spaced, descending)
        p2 = swings_high[-1]
        # find previous pivot spaced enough
        p1 = None
        for i in range(len(swings_high) - 2, -1, -1):
            if (p2[0] - swings_high[i][0]) >= cfg.min_pivot_spacing:
                p1 = swings_high[i]
                break
        if p1 is None:
            return FTLResult(detected=False)

        (i1, y1), (i2, y2) = p1, p2
        # downtrendline expects y2 < y1 (descending). If not, not a downtrendline.
        if y2 >= y1:
            return FTLResult(detected=False)

        # pivot recency
        age2 = (len(candles) - 1) - i2
        if age2 > cfg.max_pivot_age_bars:
            return FTLResult(detected=False)

        # Find break: first candle after pivot2 where close breaks above line
        break_i, break_meta = _find_break(
            candles=candles,
            direction="BULLISH",
            i1=i1, y1=y1, i2=i2, y2=y2,
            atr=atr,
            cfg=cfg,
            start=i2 + 1,
        )
        if break_i is None:
            return FTLResult(detected=False)

        # Find retest within N bars after break
        retest_i, retest_meta = _find_retest(
            candles=candles,
            direction="BULLISH",
            i1=i1, y1=y1, i2=i2, y2=y2,
            atr=atr,
            cfg=cfg,
            start=break_i + 1,
            end=min(len(candles) - 1, break_i + cfg.retest_max_bars),
        )

        status = "FORMING"
        if retest_i is not None:
            status = "CONFIRMED"
        elif not cfg.allow_forming:
            return FTLResult(detected=False)

        # Zone proximity score
        zone_score01 = 0.0
        zone_dist = None
        if cfg.zone_boost_enabled and zone_top is not None and zone_bot is not None:
            # proximity evaluated at retest if exists else break
            probe_idx = retest_i if retest_i is not None else break_i
            probe_price = _c_get(candles[probe_idx], "close")
            zone_dist = _distance_to_zone(probe_price, zone_top, zone_bot)
            if atr > 0:
                zone_score01 = _clip01(1.0 - zone_dist / max(1e-12, cfg.zone_proximity_atr_mult * atr))
            else:
                # minimal fallback
                zone_score01 = 0.5 if zone_dist == 0 else 0.0

        # Score components
        break_score01 = break_meta.get("break_score01", 0.0)
        retest_score01 = retest_meta.get("retest_score01", 0.0) if retest_meta else (0.45 if status == "FORMING" else 0.0)
        recency_score01 = _clip01(1.0 - age2 / max(1, cfg.max_pivot_age_bars))

        total01 = (
            cfg.w_break * break_score01
            + cfg.w_retest * retest_score01
            + cfg.w_recency * recency_score01
            + cfg.w_zone * zone_score01
        )
        strength = int(round(100 * _clip01(total01)))

        line_at_break = _line_value_at(i1, y1, i2, y2, break_i)
        line_at_retest = _line_value_at(i1, y1, i2, y2, retest_i) if retest_i is not None else None

        return FTLResult(
            detected=True,
            status=status,
            direction="BULLISH",
            strength=strength,
            pivot1_index=offset + i1,
            pivot1_price=float(y1),
            pivot2_index=offset + i2,
            pivot2_price=float(y2),
            break_index=offset + break_i,
            break_close=float(_c_get(candles[break_i], "close")),
            retest_index=(offset + retest_i) if retest_i is not None else None,
            retest_close=float(_c_get(candles[retest_i], "close")) if retest_i is not None else None,
            line_at_break=float(line_at_break) if line_at_break is not None else None,
            line_at_retest=float(line_at_retest) if line_at_retest is not None else None,
            atr=float(atr),
            zone_top=zone_top,
            zone_bot=zone_bot,
            zone_distance=float(zone_dist) if zone_dist is not None else None,
            details={
                "scores01": {
                    "break": round(break_score01, 3),
                    "retest": round(retest_score01, 3),
                    "recency": round(recency_score01, 3),
                    "zone": round(zone_score01, 3),
                    "total01": round(_clip01(total01), 3),
                },
                "break": break_meta,
                "retest": retest_meta,
                "pivots": {"i1": offset + i1, "y1": y1, "i2": offset + i2, "y2": y2},
            },
        )

    # ──────────────────────────────────────────────────────────────────────
    # Bearish FTL
    # ──────────────────────────────────────────────────────────────────────

    def _detect_bearish_ftl(
        self,
        candles: list[Any],
        swings_low: list[tuple[int, float]],
        atr: float,
        cfg: FTLConfig,
        offset: int,
        zone_top: Optional[float],
        zone_bot: Optional[float],
    ) -> FTLResult:
        if len(swings_low) < 2:
            return FTLResult(detected=False)

        p2 = swings_low[-1]
        p1 = None
        for i in range(len(swings_low) - 2, -1, -1):
            if (p2[0] - swings_low[i][0]) >= cfg.min_pivot_spacing:
                p1 = swings_low[i]
                break
        if p1 is None:
            return FTLResult(detected=False)

        (i1, y1), (i2, y2) = p1, p2
        # uptrendline expects y2 > y1 (ascending)
        if y2 <= y1:
            return FTLResult(detected=False)

        age2 = (len(candles) - 1) - i2
        if age2 > cfg.max_pivot_age_bars:
            return FTLResult(detected=False)

        break_i, break_meta = _find_break(
            candles=candles,
            direction="BEARISH",
            i1=i1, y1=y1, i2=i2, y2=y2,
            atr=atr,
            cfg=cfg,
            start=i2 + 1,
        )
        if break_i is None:
            return FTLResult(detected=False)

        retest_i, retest_meta = _find_retest(
            candles=candles,
            direction="BEARISH",
            i1=i1, y1=y1, i2=i2, y2=y2,
            atr=atr,
            cfg=cfg,
            start=break_i + 1,
            end=min(len(candles) - 1, break_i + cfg.retest_max_bars),
        )

        status = "FORMING"
        if retest_i is not None:
            status = "CONFIRMED"
        elif not cfg.allow_forming:
            return FTLResult(detected=False)

        zone_score01 = 0.0
        zone_dist = None
        if cfg.zone_boost_enabled and zone_top is not None and zone_bot is not None:
            probe_idx = retest_i if retest_i is not None else break_i
            probe_price = _c_get(candles[probe_idx], "close")
            zone_dist = _distance_to_zone(probe_price, zone_top, zone_bot)
            if atr > 0:
                zone_score01 = _clip01(1.0 - zone_dist / max(1e-12, cfg.zone_proximity_atr_mult * atr))
            else:
                zone_score01 = 0.5 if zone_dist == 0 else 0.0

        break_score01 = break_meta.get("break_score01", 0.0)
        retest_score01 = retest_meta.get("retest_score01", 0.0) if retest_meta else (0.45 if status == "FORMING" else 0.0)
        recency_score01 = _clip01(1.0 - age2 / max(1, cfg.max_pivot_age_bars))

        total01 = (
            cfg.w_break * break_score01
            + cfg.w_retest * retest_score01
            + cfg.w_recency * recency_score01
            + cfg.w_zone * zone_score01
        )
        strength = int(round(100 * _clip01(total01)))

        line_at_break = _line_value_at(i1, y1, i2, y2, break_i)
        line_at_retest = _line_value_at(i1, y1, i2, y2, retest_i) if retest_i is not None else None

        return FTLResult(
            detected=True,
            status=status,
            direction="BEARISH",
            strength=strength,
            pivot1_index=offset + i1,
            pivot1_price=float(y1),
            pivot2_index=offset + i2,
            pivot2_price=float(y2),
            break_index=offset + break_i,
            break_close=float(_c_get(candles[break_i], "close")),
            retest_index=(offset + retest_i) if retest_i is not None else None,
            retest_close=float(_c_get(candles[retest_i], "close")) if retest_i is not None else None,
            line_at_break=float(line_at_break) if line_at_break is not None else None,
            line_at_retest=float(line_at_retest) if line_at_retest is not None else None,
            atr=float(atr),
            zone_top=zone_top,
            zone_bot=zone_bot,
            zone_distance=float(zone_dist) if zone_dist is not None else None,
            details={
                "scores01": {
                    "break": round(break_score01, 3),
                    "retest": round(retest_score01, 3),
                    "recency": round(recency_score01, 3),
                    "zone": round(zone_score01, 3),
                    "total01": round(_clip01(total01), 3),
                },
                "break": break_meta,
                "retest": retest_meta,
                "pivots": {"i1": offset + i1, "y1": y1, "i2": offset + i2, "y2": y2},
            },
        )


# ═════════════════════════════════════════════════════════════════════════════=
# Internals — Swings / Break / Retest
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


def _break_close_strength(c: Any, direction: str) -> float:
    """0..1 close position in range."""
    h = _c_get(c, "high")
    l = _c_get(c, "low")
    cl = _c_get(c, "close")
    rng = max(1e-12, h - l)
    if direction == "BULLISH":
        return _clip01((cl - l) / rng)
    return _clip01((h - cl) / rng)


def _find_break(
    *,
    candles: list[Any],
    direction: str,   # "BULLISH" | "BEARISH"
    i1: int, y1: float,
    i2: int, y2: float,
    atr: float,
    cfg: FTLConfig,
    start: int,
) -> tuple[Optional[int], dict[str, Any]]:
    """
    Trouve la bougie de break de la trendline.
    """
    buf = cfg.break_buffer_atr_mult * atr if atr > 0 else 0.0
    meta: dict[str, Any] = {"buffer": buf, "start": start}

    for i in range(max(0, start), len(candles)):
        line = _line_value_at(i1, y1, i2, y2, i)
        if line is None:
            continue

        c = candles[i]
        o = _c_get(c, "open")
        h = _c_get(c, "high")
        l = _c_get(c, "low")
        cl = _c_get(c, "close")

        # break condition
        if direction == "BULLISH":
            broke = (cl >= line + buf) if cfg.require_close_break else (h >= line + buf)
        else:
            broke = (cl <= line - buf) if cfg.require_close_break else (l <= line - buf)

        if not broke:
            continue

        # candle quality
        rng = max(1e-12, h - l)
        body = abs(cl - o)
        if body / rng < cfg.min_break_body_to_range:
            continue

        cs = _break_close_strength(c, direction)
        if cs < cfg.min_break_close_strength:
            continue

        # score: distance vs buffer + close strength
        dist = abs(cl - line)
        dist_score01 = _clip01((dist / max(1e-12, buf if buf > 0 else (0.25 * atr if atr > 0 else dist + 1e-12))) - 1.0)
        close_score01 = _clip01((cs - cfg.min_break_close_strength) / max(1e-12, (1.0 - cfg.min_break_close_strength)))
        break_score01 = _clip01(0.55 * dist_score01 + 0.45 * close_score01)

        meta.update({
            "break_index": i,
            "line": line,
            "close": cl,
            "distance": dist,
            "close_strength": cs,
            "break_score01": round(break_score01, 3),
        })
        return i, meta

    return None, {"reason": "no_break_found", **meta}


def _find_retest(
    *,
    candles: list[Any],
    direction: str,  # "BULLISH" | "BEARISH"
    i1: int, y1: float,
    i2: int, y2: float,
    atr: float,
    cfg: FTLConfig,
    start: int,
    end: int,
) -> tuple[Optional[int], Optional[dict[str, Any]]]:
    """
    Retest (flip) :
    - Bullish : low touche la ligne (tol) et close au-dessus + rejet (wick bas)
    - Bearish : high touche la ligne et close en-dessous + rejet (wick haut)
    """
    tol = cfg.retest_tolerance_atr_mult * atr if atr > 0 else 0.0

    for i in range(max(0, start), min(len(candles) - 1, end) + 1):
        line = _line_value_at(i1, y1, i2, y2, i)
        if line is None:
            continue

        c = candles[i]
        o = _c_get(c, "open")
        h = _c_get(c, "high")
        l = _c_get(c, "low")
        cl = _c_get(c, "close")
        rng = max(1e-12, h - l)
        body = abs(cl - o)
        if body / rng < cfg.min_break_body_to_range:
            # on réutilise une contrainte simple anti-doji
            continue

        touched = _intersects_band(h, l, line, tol)
        if not touched:
            continue

        if direction == "BULLISH":
            # must close above line
            if cl < line:
                continue
            # rejection optional
            if cfg.require_retest_rejection:
                wick = _lower_wick(c)
                wick_to_body = wick / max(1e-12, body)
                wick_to_range = wick / rng
                cs = _break_close_strength(c, "BULLISH")
                if wick_to_body < cfg.min_retest_wick_to_body:
                    continue
                if wick_to_range < cfg.min_retest_wick_to_range:
                    continue
                if cs < cfg.min_retest_close_strength:
                    continue
                rej_score01 = _clip01(
                    0.5 * (wick_to_body / max(1e-12, cfg.min_retest_wick_to_body) - 1.0) +
                    0.5 * (wick_to_range / max(1e-12, cfg.min_retest_wick_to_range) - 1.0)
                )
                close_score01 = _clip01((cs - cfg.min_retest_close_strength) / max(1e-12, (1.0 - cfg.min_retest_close_strength)))
                retest_score01 = _clip01(0.60 * rej_score01 + 0.40 * close_score01)
                meta = {
                    "retest_index": i,
                    "line": line,
                    "close": cl,
                    "touched": touched,
                    "tol": tol,
                    "wick_to_body": round(wick_to_body, 3),
                    "wick_to_range": round(wick_to_range, 3),
                    "close_strength": round(cs, 3),
                    "retest_score01": round(retest_score01, 3),
                }
            else:
                retest_score01 = 0.65
                meta = {"retest_index": i, "line": line, "close": cl, "touched": touched, "tol": tol, "retest_score01": retest_score01}

            return i, meta

        else:
            # bearish
            if cl > line:
                continue
            if cfg.require_retest_rejection:
                wick = _upper_wick(c)
                wick_to_body = wick / max(1e-12, body)
                wick_to_range = wick / rng
                cs = _break_close_strength(c, "BEARISH")
                if wick_to_body < cfg.min_retest_wick_to_body:
                    continue
                if wick_to_range < cfg.min_retest_wick_to_range:
                    continue
                if cs < cfg.min_retest_close_strength:
                    continue
                rej_score01 = _clip01(
                    0.5 * (wick_to_body / max(1e-12, cfg.min_retest_wick_to_body) - 1.0) +
                    0.5 * (wick_to_range / max(1e-12, cfg.min_retest_wick_to_range) - 1.0)
                )
                close_score01 = _clip01((cs - cfg.min_retest_close_strength) / max(1e-12, (1.0 - cfg.min_retest_close_strength)))
                retest_score01 = _clip01(0.60 * rej_score01 + 0.40 * close_score01)
                meta = {
                    "retest_index": i,
                    "line": line,
                    "close": cl,
                    "touched": touched,
                    "tol": tol,
                    "wick_to_body": round(wick_to_body, 3),
                    "wick_to_range": round(wick_to_range, 3),
                    "close_strength": round(cs, 3),
                    "retest_score01": round(retest_score01, 3),
                }
            else:
                retest_score01 = 0.65
                meta = {"retest_index": i, "line": line, "close": cl, "touched": touched, "tol": tol, "retest_score01": retest_score01}

            return i, meta

    return None, None