```python
"""
utils/candle_utils.py — Helpers bougies OHLCV (IGNIS)

But :
- Fournir des helpers réutilisables par tout le moteur HLZ :
  • accès tolérant dict/obj
  • mesures bougie (range, body, wicks, close strength)
  • True Range / ATR
  • distances et interactions avec zones (intersects, distance_to_zone, penetration)

Design :
- Stateless
- Sans dépendance pandas
- Tolérant aux inputs (dict, SQLAlchemy model, Pydantic model)
"""

from __future__ import annotations

from typing import Any, Optional, Protocol, runtime_checkable, Literal

import math


Direction = Literal["BULLISH", "BEARISH"]


@runtime_checkable
class CandleLike(Protocol):
    open: float
    high: float
    low: float
    close: float


# ─────────────────────────────────────────────────────────────────────────────
# Access helpers
# ─────────────────────────────────────────────────────────────────────────────

def c_get(c: Any, key: str, default: Any = 0.0) -> Any:
    """Lecture tolérante (dict ou attribut)."""
    if isinstance(c, dict):
        return c.get(key, default)
    return getattr(c, key, default)


def f(x: Any, default: float = 0.0) -> float:
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except Exception:
        return default


# ─────────────────────────────────────────────────────────────────────────────
# Candle measures
# ─────────────────────────────────────────────────────────────────────────────

def candle_range(c: Any) -> float:
    return max(0.0, f(c_get(c, "high")) - f(c_get(c, "low")))


def candle_body(c: Any) -> float:
    return abs(f(c_get(c, "close")) - f(c_get(c, "open")))


def upper_wick(c: Any) -> float:
    o = f(c_get(c, "open"))
    cl = f(c_get(c, "close"))
    h = f(c_get(c, "high"))
    return max(0.0, h - max(o, cl))


def lower_wick(c: Any) -> float:
    o = f(c_get(c, "open"))
    cl = f(c_get(c, "close"))
    l = f(c_get(c, "low"))
    return max(0.0, min(o, cl) - l)


def is_bull(c: Any) -> bool:
    return f(c_get(c, "close")) > f(c_get(c, "open"))


def is_bear(c: Any) -> bool:
    return f(c_get(c, "close")) < f(c_get(c, "open"))


def close_strength(c: Any, direction: Direction) -> float:
    """
    0..1 : position du close dans le range.
    - BULLISH => close proche du high => score élevé
    - BEARISH => close proche du low  => score élevé
    """
    h = f(c_get(c, "high"))
    l = f(c_get(c, "low"))
    cl = f(c_get(c, "close"))
    rng = max(1e-12, h - l)

    if direction == "BULLISH":
        return clip01((cl - l) / rng)
    return clip01((h - cl) / rng)


def body_to_range(c: Any) -> float:
    rng = candle_range(c)
    if rng <= 0:
        return 0.0
    return candle_body(c) / rng


# ─────────────────────────────────────────────────────────────────────────────
# True Range / ATR
# ─────────────────────────────────────────────────────────────────────────────

def true_range(c: Any, prev_close: Optional[float] = None) -> float:
    h = f(c_get(c, "high"))
    l = f(c_get(c, "low"))
    if prev_close is None:
        return max(0.0, h - l)
    pc = float(prev_close)
    return max(h - l, abs(h - pc), abs(l - pc))


def compute_atr(candles: list[Any], period: int = 14) -> float:
    """
    ATR simple = moyenne des True Range des `period` dernières bougies.
    """
    if not candles or len(candles) < period + 2:
        return 0.0

    trs: list[float] = []
    start = len(candles) - period - 1

    for i in range(start + 1, len(candles)):
        cur = candles[i]
        prev = candles[i - 1]
        tr = true_range(cur, prev_close=f(c_get(prev, "close")))
        if tr > 0:
            trs.append(tr)

    return (sum(trs) / len(trs)) if trs else 0.0


# ─────────────────────────────────────────────────────────────────────────────
# Zone interactions
# ─────────────────────────────────────────────────────────────────────────────

def normalize_bounds(top: float, bot: float) -> tuple[float, float]:
    top = float(top)
    bot = float(bot)
    return (top, bot) if top >= bot else (bot, top)


def intersects_zone(*, high: float, low: float, zone_top: float, zone_bot: float) -> bool:
    """True si [low,high] intersecte [zone_bot,zone_top]."""
    zt, zb = normalize_bounds(zone_top, zone_bot)
    return not (high < zb or low > zt)


def distance_to_zone(price: float, *, zone_top: float, zone_bot: float) -> float:
    """Distance au bord le plus proche (0 si dans la zone)."""
    zt, zb = normalize_bounds(zone_top, zone_bot)
    p = float(price)
    if p > zt:
        return p - zt
    if p < zb:
        return zb - p
    return 0.0


def penetration_pct(
    *,
    high: float,
    low: float,
    zone_top: float,
    zone_bot: float,
    side: Literal["DEMAND", "SUPPLY"],
) -> float:
    """
    Pénétration normalisée 0..1 dans une zone.
    - DEMAND : depuis top vers bot via low
    - SUPPLY : depuis bot vers top via high
    """
    zt, zb = normalize_bounds(zone_top, zone_bot)
    height = max(1e-12, zt - zb)

    if side == "DEMAND":
        pen = max(0.0, zt - float(low))
    else:
        pen = max(0.0, float(high) - zb)

    return clip01(pen / height)


# ─────────────────────────────────────────────────────────────────────────────
# Math small helpers
# ─────────────────────────────────────────────────────────────────────────────

def clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def pct_distance(a: float, b: float) -> float:
    """Distance relative (0.01 = 1%)."""
    b = float(b)
    if b == 0:
        return 999.0
    return abs(float(a) - b) / abs(b)


__all__ = [
    "CandleLike",
    "Direction",
    "c_get",
    "f",
    "clip01",
    "pct_distance",
    "candle_range",
    "candle_body",
    "upper_wick",
    "lower_wick",
    "is_bull",
    "is_bear",
    "close_strength",
    "body_to_range",
    "true_range",
    "compute_atr",
    "normalize_bounds",
    "intersects_zone",
    "distance_to_zone",
    "penetration_pct",
]
```