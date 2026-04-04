```python
"""
utils/math_utils.py — Helpers math / prix (IGNIS)

But :
- Fournir des utilitaires de calcul utilisés dans le moteur HLZ :
  • arrondis (tick/pip)
  • RR, risk, reward
  • clamp / clip
  • conversions pips/points (génériques)
  • distances prix / %
  • niveaux fib (golden zone)

Design :
- Stateless
- Sans dépendance externe
"""

from __future__ import annotations

import math
from typing import Optional, Literal


Side = Literal["LONG", "SHORT"]
Direction = Literal["BULLISH", "BEARISH"]


def is_finite(x: float) -> bool:
    try:
        return math.isfinite(float(x))
    except Exception:
        return False


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def pct_change(a: float, b: float) -> float:
    """(b-a)/a ; ex: 0.01 = +1%"""
    a = float(a)
    if a == 0:
        return 0.0
    return (float(b) - a) / abs(a)


def pct_distance(a: float, b: float) -> float:
    """|a-b|/|b| ; ex: 0.01 = 1%"""
    b = float(b)
    if b == 0:
        return 999.0
    return abs(float(a) - b) / abs(b)


def round_to_step(price: float, step: float) -> float:
    """
    Arrondit un prix au "step" (tick size).
    Ex: step=0.01 => 1.234 -> 1.23
    """
    p = float(price)
    s = float(step)
    if s <= 0:
        return p
    return round(p / s) * s


def risk(entry: float, sl: float) -> float:
    return abs(float(entry) - float(sl))


def reward(entry: float, tp: float) -> float:
    return abs(float(tp) - float(entry))


def rr(entry: float, sl: float, tp: float) -> float:
    r = risk(entry, sl)
    if r <= 0:
        return 0.0
    return reward(entry, tp) / r


def rr_side(entry: float, sl: float, tp: float, side: Side) -> float:
    """
    RR en vérifiant cohérence directionnelle.
    - LONG : sl < entry < tp
    - SHORT: tp < entry < sl
    Si incohérent => 0
    """
    e = float(entry)
    s = float(sl)
    t = float(tp)

    if side == "LONG":
        if not (s < e < t):
            return 0.0
    else:
        if not (t < e < s):
            return 0.0

    return rr(e, s, t)


def fib_levels(low: float, high: float, levels: Optional[list[float]] = None) -> dict[float, float]:
    """
    Renvoie un mapping ratio->price sur le segment [low,high] (low<high).
    """
    lo = float(low)
    hi = float(high)
    if hi < lo:
        lo, hi = hi, lo

    if levels is None:
        levels = [0.236, 0.382, 0.5, 0.618, 0.786]

    span = hi - lo
    return {float(r): lo + float(r) * span for r in levels}


def golden_zone(low: float, high: float) -> tuple[float, float]:
    """
    Golden zone fib 0.618–0.786 sur segment [low,high]
    Retourne (gz_low, gz_high) en prix (ordre croissant).
    """
    lo = float(low)
    hi = float(high)
    if hi < lo:
        lo, hi = hi, lo
    span = hi - lo
    gz1 = lo + 0.618 * span
    gz2 = lo + 0.786 * span
    return (min(gz1, gz2), max(gz1, gz2))


def pip_value(price: float) -> float:
    """
    Heuristique pip value :
    - Forex majeurs ~ 0.0001
    - JPY pairs ~ 0.01
    - Crypto/stocks: renvoie 0 (non applicable)
    """
    p = abs(float(price))
    if p <= 0:
        return 0.0
    # JPY-like
    if 50 <= p <= 300:
        return 0.01
    # Forex-like
    if p < 10:
        return 0.0001
    return 0.0


__all__ = [
    "Side",
    "Direction",
    "is_finite",
    "clamp",
    "clip01",
    "pct_change",
    "pct_distance",
    "round_to_step",
    "risk",
    "reward",
    "rr",
    "rr_side",
    "fib_levels",
    "golden_zone",
    "pip_value",
]
```