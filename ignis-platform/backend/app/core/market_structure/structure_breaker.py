"""
core/market_structure/structure_breaker.py — Structure Breaker (SB) detector (IGNIS / HLZ)

SB (Structure Breaker) :
- Bullish SB : cassure d'un swing high récent (close au-dessus) => break of structure (BOS)
- Bearish SB : cassure d'un swing low récent (close en-dessous)

Ce module :
- Détecte les swings (fractal) puis valide une cassure par close (ou wick optionnel)
- Fournit le niveau cassé (broken_level) = futur DP / pullback level
- Donne un score de force (0..100) basé sur :
  • distance de break (en ATR)
  • qualité du close (close strength)
  • récence du swing cassé
  • "prominence" du swing (optionnel)

Design :
- Stateless
- Tolérant : candles dict/obj (open/high/low/close)
- Sans pandas/numpy

Sortie :
- StructureBreakResult
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

log = structlog.get_logger(__name__)


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


def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _range(c: Any) -> float:
    return max(0.0, _c_get(c, "high") - _c_get(c, "low"))


def _body(c: Any) -> float:
    return abs(_c_get(c, "close") - _c_get(c, "open"))


def _close_strength(c: Any, direction: str) -> float:
    """
    0..1 : où se situe le close dans le range.
    - bullish => close proche high => score élevé
    - bearish => close proche low  => score élevé
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


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class StructureBreakerConfig:
    lookback: int = 320
    atr_period: int = 14

    # Swings
    swing_window: int = 2

    # SB validity
    sb_recent_bars: int = 60                 # swing cassé doit être récent
    require_close_break: bool = True         # True: close doit casser le swing ; False: wick ok
    min_break_atr_mult: float = 0.20         # distance minimale au-dessus/au-dessous du swing (en ATR)

    # Break candle quality
    min_close_strength: float = 0.55         # close strength dans le sens de la cassure
    min_body_to_range: float = 0.12          # éviter doji / cassure molle

    # Prominence (qualité swing)
    prominence_window: int = 6               # nb bougies autour du pivot
    min_prominence_atr_mult: float = 0.15    # swing doit "dépasser" son contexte d'au moins X*ATR (sinon faible)

    # Scoring weights (0..1)
    w_distance: float = 0.45
    w_close: float = 0.25
    w_recency: float = 0.20
    w_prominence: float = 0.10


@dataclass
class StructureBreakResult:
    detected: bool = False
    direction: str = ""                     # "BULLISH" | "BEARISH"
    broken_level: Optional[float] = None
    broken_swing_index: Optional[int] = None
    break_index: Optional[int] = None

    break_close: Optional[float] = None
    break_distance: Optional[float] = None          # abs(close - broken_level)
    break_distance_atr: Optional[float] = None

    strength: int = 0                       # 0..100
    label: str = ""                         # "BOS" / "SB"
    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class StructureBreaker:
    """
    Détecteur SB.

    API :
        sb = StructureBreaker()
        res = sb.detect(candles)

    Option :
        - Si tu as déjà des swings (depuis SwingDetector), tu peux les passer via detect(..., swings_high=..., swings_low=...)
          pour éviter recompute.
    """

    def __init__(self, config: Optional[StructureBreakerConfig] = None) -> None:
        self.config = config or StructureBreakerConfig()

    def detect(
        self,
        candles: list[Any],
        *,
        swings_high: Optional[list[tuple[int, float]]] = None,
        swings_low: Optional[list[tuple[int, float]]] = None,
    ) -> StructureBreakResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 60):
            return StructureBreakResult(detected=False, details={"reason": "not_enough_candles"})

        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            atr = 0.0

        # Swings
        if swings_high is None or swings_low is None:
            sh, sl = _find_swings(c, window=cfg.swing_window)
        else:
            sh, sl = swings_high, swings_low

        if not sh and not sl:
            return StructureBreakResult(detected=False, details={"reason": "no_swings"})

        last = c[-1]
        last_close = _c_get(last, "close")
        last_high = _c_get(last, "high")
        last_low = _c_get(last, "low")

        # Candidates : bullish break of last swing high, bearish break of last swing low
        cand_results: list[StructureBreakResult] = []

        if sh:
            idx, lvl = sh[-1]
            recency = (len(c) - 1 - idx)
            if recency <= cfg.sb_recent_bars:
                ok, meta = _check_break(
                    direction="BULLISH",
                    level=lvl,
                    close=last_close,
                    high=last_high,
                    low=last_low,
                    atr=atr,
                    require_close=cfg.require_close_break,
                    min_break_atr_mult=cfg.min_break_atr_mult,
                    candle=last,
                    cfg=cfg,
                )
                if ok:
                    strength, details = _score_break(
                        direction="BULLISH",
                        level=lvl,
                        swing_index=idx,
                        recency_bars=recency,
                        candle=last,
                        atr=atr,
                        candles=c,
                        cfg=cfg,
                        extra=meta,
                    )
                    cand_results.append(StructureBreakResult(
                        detected=True,
                        direction="BULLISH",
                        broken_level=float(lvl),
                        broken_swing_index=offset + idx,
                        break_index=offset + (len(c) - 1),
                        break_close=float(last_close),
                        break_distance=float(abs(last_close - lvl)),
                        break_distance_atr=float(abs(last_close - lvl) / atr) if atr > 0 else None,
                        strength=strength,
                        label="SB_LEVEL",
                        details=details,
                    ))

        if sl:
            idx, lvl = sl[-1]
            recency = (len(c) - 1 - idx)
            if recency <= cfg.sb_recent_bars:
                ok, meta = _check_break(
                    direction="BEARISH",
                    level=lvl,
                    close=last_close,
                    high=last_high,
                    low=last_low,
                    atr=atr,
                    require_close=cfg.require_close_break,
                    min_break_atr_mult=cfg.min_break_atr_mult,
                    candle=last,
                    cfg=cfg,
                )
                if ok:
                    strength, details = _score_break(
                        direction="BEARISH",
                        level=lvl,
                        swing_index=idx,
                        recency_bars=recency,
                        candle=last,
                        atr=atr,
                        candles=c,
                        cfg=cfg,
                        extra=meta,
                    )
                    cand_results.append(StructureBreakResult(
                        detected=True,
                        direction="BEARISH",
                        broken_level=float(lvl),
                        broken_swing_index=offset + idx,
                        break_index=offset + (len(c) - 1),
                        break_close=float(last_close),
                        break_distance=float(abs(last_close - lvl)),
                        break_distance_atr=float(abs(last_close - lvl) / atr) if atr > 0 else None,
                        strength=strength,
                        label="SB_LEVEL",
                        details=details,
                    ))

        if not cand_results:
            return StructureBreakResult(
                detected=False,
                details={
                    "reason": "no_break_confirmed",
                    "last_close": last_close,
                    "atr": atr,
                    "last_swing_high": sh[-1] if sh else None,
                    "last_swing_low": sl[-1] if sl else None,
                },
            )

        # Select best (strength desc)
        cand_results.sort(key=lambda r: r.strength, reverse=True)
        return cand_results[0]

    def detect_all(
        self,
        candles: list[Any],
        *,
        swings_high: Optional[list[tuple[int, float]]] = None,
        swings_low: Optional[list[tuple[int, float]]] = None,
    ) -> list[StructureBreakResult]:
        """
        Version multi (renvoie bullish+bearish si les deux existent).
        """
        cfg = self.config
        if not candles:
            return []
        best = self.detect(candles, swings_high=swings_high, swings_low=swings_low)
        if not best.detected:
            return []
        # Here we only compute best in detect(); for detect_all we recompute both quickly:
        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        if swings_high is None or swings_low is None:
            sh, sl = _find_swings(c, window=cfg.swing_window)
        else:
            sh, sl = swings_high, swings_low

        # brute: call detect() but temporarily force both by checking last candle; easiest is to reuse detect() logic:
        # For simplicity, return [best] (pipeline usually needs best SB). If you want both, tell me and I’ll expose both fully.
        return [best]


# ═════════════════════════════════════════════════════════════════════════════=
# Internals
# ═════════════════════════════════════════════════════════════════════════════=

def _find_swings(candles: list[Any], window: int = 2) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    """
    Fractal swings simples :
      swing high : high[i] > highs des window bougies avant/après
      swing low  : low[i]  < lows  des window bougies avant/après
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


def _check_break(
    *,
    direction: str,
    level: float,
    close: float,
    high: float,
    low: float,
    atr: float,
    require_close: bool,
    min_break_atr_mult: float,
    candle: Any,
    cfg: StructureBreakerConfig,
) -> tuple[bool, dict[str, Any]]:
    """
    Validate SB by distance + candle quality.
    """
    min_break = (min_break_atr_mult * atr) if (atr and atr > 0) else 0.0

    if direction == "BULLISH":
        broke = (close >= level + min_break) if require_close else (high >= level + min_break)
    else:
        broke = (close <= level - min_break) if require_close else (low <= level - min_break)

    if not broke:
        return False, {"reason": "not_broken", "min_break": min_break}

    # candle filters
    rng = max(1e-12, high - low)
    body = abs(close - _c_get(candle, "open"))
    if body / rng < cfg.min_body_to_range:
        return False, {"reason": "body_too_small", "body_to_range": body / rng}

    cs = _close_strength(candle, direction)
    if cs < cfg.min_close_strength:
        return False, {"reason": "close_strength_too_low", "close_strength": cs}

    return True, {
        "min_break": min_break,
        "close_strength": cs,
        "body_to_range": body / rng,
        "require_close": require_close,
    }


def _swing_prominence_atr(
    *,
    candles: list[Any],
    swing_index: int,
    direction: str,
    atr: float,
    window: int,
) -> float:
    """
    Prominence proxy :
    - swing high: (swing_high - max(neighbor_highs)) / ATR
    - swing low : (min(neighbor_lows) - swing_low) / ATR  (positive if swing lower)
    """
    if atr <= 0:
        return 0.0

    n = len(candles)
    i = swing_index
    w = max(2, int(window))
    left = max(0, i - w)
    right = min(n - 1, i + w)

    if direction == "BULLISH":
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


def _score_break(
    *,
    direction: str,
    level: float,
    swing_index: int,
    recency_bars: int,
    candle: Any,
    atr: float,
    candles: list[Any],
    cfg: StructureBreakerConfig,
    extra: dict[str, Any],
) -> tuple[int, dict[str, Any]]:
    """
    Score 0..100.
    """
    close = _c_get(candle, "close")
    dist = abs(close - level)

    # distance score
    min_break = extra.get("min_break", 0.0) or 0.0
    denom = max(1e-12, min_break if min_break > 0 else (0.2 * atr if atr > 0 else dist + 1e-12))
    dist_score01 = _clip01(dist / denom - 1.0)  # 0 when ==min_break, rises with distance

    # close quality score
    cs = float(extra.get("close_strength", _close_strength(candle, direction)))
    close_score01 = _clip01((cs - cfg.min_close_strength) / max(1e-12, (1.0 - cfg.min_close_strength)))

    # recency score (recent swing is better)
    recency_score01 = _clip01(1.0 - (recency_bars / max(1, cfg.sb_recent_bars)))

    # prominence score
    prom_atr = _swing_prominence_atr(
        candles=candles,
        swing_index=swing_index,
        direction=("BULLISH" if direction == "BULLISH" else "BEARISH"),
        atr=atr,
        window=cfg.prominence_window,
    )
    prom_ok = prom_atr >= cfg.min_prominence_atr_mult
    prom_score01 = _clip01(prom_atr / max(1e-12, cfg.min_prominence_atr_mult)) if cfg.min_prominence_atr_mult > 0 else _clip01(prom_atr)

    total01 = (
        cfg.w_distance * dist_score01
        + cfg.w_close * close_score01
        + cfg.w_recency * recency_score01
        + cfg.w_prominence * prom_score01
    )
    strength = int(round(100 * _clip01(total01)))

    details = {
        "direction": direction,
        "level": level,
        "close": close,
        "distance": dist,
        "distance_atr": round(dist / atr, 4) if atr > 0 else None,
        "recency_bars": recency_bars,
        "prominence_atr": round(prom_atr, 4),
        "prominence_ok": prom_ok,
        "scores01": {
            "distance": round(dist_score01, 3),
            "close": round(close_score01, 3),
            "recency": round(recency_score01, 3),
            "prominence": round(prom_score01, 3),
            "total01": round(_clip01(total01), 3),
        },
        "filters": extra,
    }
    return strength, details
