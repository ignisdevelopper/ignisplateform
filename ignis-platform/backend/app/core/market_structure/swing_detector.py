"""
core/market_structure/swing_detector.py — Swing / Structure detector (IGNIS / HLZ)

Rôle :
- Détecter les swings (pivots) High/Low (fractal)
- Classifier la structure : HH/HL/LH/LL
- Déduire une tendance simple : BULLISH / BEARISH / RANGE
- Fournir des niveaux utiles (dernier swing high/low, derniers HH/HL...)

Design :
- Stateless
- Tolérant aux candles dict/obj (open/high/low/close + time optionnel)
- Sans pandas/numpy

Sortie :
- SwingStructureResult :
    • swings_high, swings_low (pivots bruts)
    • swing_points (liste ordonnée, avec labels HH/HL/LH/LL)
    • trend + structure string ("HH/HL", "LH/LL", etc.)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable, Literal

import structlog

log = structlog.get_logger(__name__)

SwingKind = Literal["HIGH", "LOW"]
SwingLabel = Literal["HH", "LH", "HL", "LL", "SH", "SL"]  # SH/SL = 1er pivot (seed) ou non-classifiable


# ═════════════════════════════════════════════════════════════════════════════=
# Candle helpers (tolérant)
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


def _c_time(c: Any) -> Optional[Any]:
    """Best-effort time field for external usage (not used for logic)."""
    if isinstance(c, dict):
        return c.get("open_time") or c.get("timestamp") or c.get("time") or c.get("t")
    return getattr(c, "open_time", None) or getattr(c, "timestamp", None) or getattr(c, "time", None)


def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


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


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class SwingDetectorConfig:
    lookback: int = 600
    atr_period: int = 14

    # Fractal swings
    swing_window: int = 2  # pivot if higher/lower than +/- window neighbors

    # Noise filtering
    enable_prominence_filter: bool = True
    prominence_window: int = 6
    min_prominence_atr_mult: float = 0.15

    # Merge pivots too close
    min_separation_bars: int = 2

    # Trend inference
    min_points_for_trend: int = 4
    prefer_recent_structure: bool = True
    structure_recency_bars: int = 120  # for confidence score


@dataclass
class SwingPoint:
    index: int
    price: float
    kind: SwingKind                 # HIGH | LOW
    label: SwingLabel = "SH"        # HH/LH/HL/LL/SH/SL
    time: Optional[Any] = None

    prominence_atr: float = 0.0
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "price": self.price,
            "kind": self.kind,
            "label": self.label,
            "prominence_atr": round(self.prominence_atr, 4),
            "time": str(self.time) if self.time is not None else None,
            "details": self.details,
        }


@dataclass
class SwingStructureResult:
    detected: bool = False
    trend: str = "RANGE"                     # BULLISH | BEARISH | RANGE
    structure: str = ""                      # e.g. "HH/HL" or "LH/LL"
    confidence: int = 0                      # 0..100

    atr: float = 0.0
    swing_points: list[SwingPoint] = field(default_factory=list)

    swings_high: list[tuple[int, float]] = field(default_factory=list)
    swings_low: list[tuple[int, float]] = field(default_factory=list)

    last_swing_high: Optional[float] = None
    last_swing_low: Optional[float] = None
    last_hh: Optional[float] = None
    last_hl: Optional[float] = None
    last_lh: Optional[float] = None
    last_ll: Optional[float] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class SwingDetector:
    """
    Détecteur de swings & structure.

    Usage :
        det = SwingDetector()
        res = det.detect(candles)
        res.structure -> "HH/HL"
        res.trend     -> "BULLISH"
    """

    def __init__(self, config: Optional[SwingDetectorConfig] = None) -> None:
        self.config = config or SwingDetectorConfig()

    def detect(self, candles: list[Any]) -> SwingStructureResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 50):
            return SwingStructureResult(
                detected=False,
                details={"reason": "not_enough_candles"},
            )

        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            atr = 0.0

        # 1) Swings (raw)
        highs, lows = _find_swings(c, window=cfg.swing_window)

        # 2) Prominence filter (optional)
        if cfg.enable_prominence_filter and atr > 0:
            highs = [
                (i, p) for i, p in highs
                if _swing_prominence_atr(c, i, "HIGH", atr, cfg.prominence_window) >= cfg.min_prominence_atr_mult
            ]
            lows = [
                (i, p) for i, p in lows
                if _swing_prominence_atr(c, i, "LOW", atr, cfg.prominence_window) >= cfg.min_prominence_atr_mult
            ]

        # 3) Merge/clean pivots too close
        highs = _merge_close_swings(highs, kind="HIGH", min_sep=cfg.min_separation_bars)
        lows = _merge_close_swings(lows, kind="LOW", min_sep=cfg.min_separation_bars)

        # 4) Build ordered swing points list
        points: list[SwingPoint] = []
        for i, p in highs:
            prom = _swing_prominence_atr(c, i, "HIGH", atr, cfg.prominence_window) if (cfg.enable_prominence_filter and atr > 0) else 0.0
            points.append(SwingPoint(
                index=offset + i,
                price=float(p),
                kind="HIGH",
                label="SH",
                time=_c_time(c[i]),
                prominence_atr=float(prom),
            ))
        for i, p in lows:
            prom = _swing_prominence_atr(c, i, "LOW", atr, cfg.prominence_window) if (cfg.enable_prominence_filter and atr > 0) else 0.0
            points.append(SwingPoint(
                index=offset + i,
                price=float(p),
                kind="LOW",
                label="SL",
                time=_c_time(c[i]),
                prominence_atr=float(prom),
            ))

        points.sort(key=lambda sp: sp.index)

        # 5) Label HH/LH and HL/LL
        _label_structure(points)

        # 6) Infer trend
        trend, structure, conf = _infer_trend(points, len(candles) - 1, cfg)

        # 7) Extract last labeled levels
        last_swing_high = next((p.price for p in reversed(points) if p.kind == "HIGH"), None)
        last_swing_low = next((p.price for p in reversed(points) if p.kind == "LOW"), None)

        last_hh = next((p.price for p in reversed(points) if p.kind == "HIGH" and p.label == "HH"), None)
        last_lh = next((p.price for p in reversed(points) if p.kind == "HIGH" and p.label == "LH"), None)
        last_hl = next((p.price for p in reversed(points) if p.kind == "LOW" and p.label == "HL"), None)
        last_ll = next((p.price for p in reversed(points) if p.kind == "LOW" and p.label == "LL"), None)

        detected = len(points) >= 2

        return SwingStructureResult(
            detected=detected,
            trend=trend,
            structure=structure,
            confidence=conf,
            atr=float(atr),
            swing_points=points,
            swings_high=[(offset + i, float(p)) for i, p in highs],
            swings_low=[(offset + i, float(p)) for i, p in lows],
            last_swing_high=last_swing_high,
            last_swing_low=last_swing_low,
            last_hh=last_hh,
            last_hl=last_hl,
            last_lh=last_lh,
            last_ll=last_ll,
            details={
                "counts": {"points": len(points), "highs": len(highs), "lows": len(lows)},
                "config": {
                    "swing_window": cfg.swing_window,
                    "prominence_filter": cfg.enable_prominence_filter,
                    "min_prominence_atr_mult": cfg.min_prominence_atr_mult,
                    "min_separation_bars": cfg.min_separation_bars,
                },
            },
        )


# ═════════════════════════════════════════════════════════════════════════════=
# Internals
# ═════════════════════════════════════════════════════════════════════════════=

def _find_swings(candles: list[Any], window: int = 2) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    """
    Fractal swings :
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


def _swing_prominence_atr(
    candles: list[Any],
    pivot_index: int,
    kind: SwingKind,
    atr: float,
    window: int,
) -> float:
    """
    Prominence proxy en ATR :
      HIGH: (pivot_high - max(neighbor_highs)) / ATR
      LOW : (min(neighbor_lows) - pivot_low) / ATR
    """
    if atr <= 0:
        return 0.0

    n = len(candles)
    w = max(2, int(window))
    i = pivot_index
    left = max(0, i - w)
    right = min(n - 1, i + w)

    if kind == "HIGH":
        pivot = _c_get(candles[i], "high")
        neigh = [_c_get(candles[j], "high") for j in range(left, right + 1) if j != i]
        if not neigh:
            return 0.0
        prom = pivot - max(neigh)
    else:
        pivot = _c_get(candles[i], "low")
        neigh = [_c_get(candles[j], "low") for j in range(left, right + 1) if j != i]
        if not neigh:
            return 0.0
        prom = min(neigh) - pivot

    return max(0.0, prom / atr)


def _merge_close_swings(
    swings: list[tuple[int, float]],
    *,
    kind: SwingKind,
    min_sep: int,
) -> list[tuple[int, float]]:
    """
    Fusionne les swings trop proches en gardant :
      - HIGH : le plus haut
      - LOW  : le plus bas
    """
    if not swings:
        return []

    swings = sorted(swings, key=lambda x: x[0])
    out: list[tuple[int, float]] = [swings[0]]

    for idx, price in swings[1:]:
        last_idx, last_price = out[-1]
        if idx - last_idx <= max(0, int(min_sep)):
            # keep best within cluster
            if kind == "HIGH":
                if price > last_price:
                    out[-1] = (idx, price)
            else:
                if price < last_price:
                    out[-1] = (idx, price)
        else:
            out.append((idx, price))

    return out


def _label_structure(points: list[SwingPoint]) -> None:
    """
    Affecte labels :
      - HIGH pivots : HH ou LH
      - LOW pivots  : HL ou LL
    """
    last_high: Optional[float] = None
    last_low: Optional[float] = None

    for p in points:
        if p.kind == "HIGH":
            if last_high is None:
                p.label = "SH"
            else:
                p.label = "HH" if p.price > last_high else "LH"
            last_high = p.price
        else:
            if last_low is None:
                p.label = "SL"
            else:
                p.label = "HL" if p.price > last_low else "LL"
            last_low = p.price


def _infer_trend(
    points: list[SwingPoint],
    last_candle_index: int,
    cfg: SwingDetectorConfig,
) -> tuple[str, str, int]:
    """
    Trend logic (simple & stable) :
      - BULLISH : most recent HIGH label is HH and most recent LOW label is HL
      - BEARISH : most recent HIGH label is LH and most recent LOW label is LL
      - else RANGE

    Confidence based on:
      - number of labeled points
      - recency of the last HH/HL or LH/LL pair
      - consistency (how many of last N points match trend)
    """
    if len(points) < cfg.min_points_for_trend:
        return "RANGE", "", 0

    last_high = next((p for p in reversed(points) if p.kind == "HIGH"), None)
    last_low = next((p for p in reversed(points) if p.kind == "LOW"), None)
    if not last_high or not last_low:
        return "RANGE", "", 0

    structure = f"{last_high.label}/{last_low.label}"

    if last_high.label == "HH" and last_low.label == "HL":
        trend = "BULLISH"
    elif last_high.label == "LH" and last_low.label == "LL":
        trend = "BEARISH"
    else:
        trend = "RANGE"

    # confidence
    recent_points = points[-min(10, len(points)):]
    if trend == "BULLISH":
        match = sum(1 for p in recent_points if p.label in ("HH", "HL"))
    elif trend == "BEARISH":
        match = sum(1 for p in recent_points if p.label in ("LH", "LL"))
    else:
        match = sum(1 for p in recent_points if p.label in ("HH", "HL", "LH", "LL"))

    consistency = match / len(recent_points)

    # recency of last structure confirmation
    # approximate with bar distance between last pivot index and last candle
    age_bars = max(0, last_candle_index - max(last_high.index, last_low.index))
    recency_score01 = _clip01(1.0 - (age_bars / max(1, cfg.structure_recency_bars)))

    base_score01 = 0.35 + 0.45 * consistency + 0.20 * recency_score01
    if trend == "RANGE":
        base_score01 *= 0.75

    conf = int(round(100 * _clip01(base_score01)))
    return trend, structure, conf
