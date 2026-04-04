"""
core/market_structure/phase_detector.py — Market Phase Detector (IGNIS / HLZ)

Détecte la phase de marché :
- RALLY : impulsion haussière dominante
- DROP  : impulsion baissière dominante
- BASE  : consolidation / compression (range serré, overlap élevé)
- CHOP  : marché désordonné (alternance, pas d'impulsion claire)

Design :
- Stateless
- Tolérant aux candles dict/obj (open/high/low/close)
- Sans pandas/numpy

Sortie :
- PhaseResult(phase, trend, strength, metrics)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

from app import MarketPhase

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


def _range(c: Any) -> float:
    return max(0.0, _c_get(c, "high") - _c_get(c, "low"))


def _body(c: Any) -> float:
    return abs(_c_get(c, "close") - _c_get(c, "open"))


def _is_bull(c: Any) -> bool:
    return _c_get(c, "close") > _c_get(c, "open")


def _is_bear(c: Any) -> bool:
    return _c_get(c, "close") < _c_get(c, "open")


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


def _overlap_ratio(candles: list[Any]) -> float:
    """Proportion de bougies dont le range chevauche le range précédent."""
    if len(candles) < 2:
        return 0.0
    overlaps = 0
    for i in range(1, len(candles)):
        a = candles[i - 1]
        b = candles[i]
        a_hi, a_lo = _c_get(a, "high"), _c_get(a, "low")
        b_hi, b_lo = _c_get(b, "high"), _c_get(b, "low")
        if not (b_hi < a_lo or b_lo > a_hi):
            overlaps += 1
    return overlaps / max(1, (len(candles) - 1))


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class PhaseDetectorConfig:
    lookback: int = 220
    atr_period: int = 14

    # Impulse detection (RALLY / DROP)
    impulse_window: int = 35
    min_impulse_net_atr_mult: float = 2.0
    min_impulse_directional_pct: float = 0.62
    min_impulse_avg_range_atr_mult: float = 0.85

    # Base detection (compression)
    base_window: int = 25
    max_base_height_atr_mult: float = 1.25
    max_base_avg_range_atr_mult: float = 0.70
    min_base_overlap_ratio: float = 0.58
    max_base_directional_pct: float = 0.62  # si trop directionnel, ce n'est pas une base

    # Chop detection
    chop_window: int = 35
    max_chop_net_atr_mult: float = 1.1
    min_chop_volatility_atr_mult: float = 0.75   # avg range assez présent
    max_chop_directional_bias: float = 0.15      # |bull_frac - bear_frac| faible => alternance

    # Scoring weights
    w_impulse: float = 0.55
    w_base: float = 0.30
    w_chop: float = 0.15


@dataclass
class PhaseResult:
    phase: str = MarketPhase.CHOP
    trend: str = ""            # "BULLISH" | "BEARISH" | "RANGE"
    strength: int = 0          # 0..100 (confiance)

    atr: float = 0.0
    metrics: dict[str, Any] = field(default_factory=dict)
    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class PhaseDetector:
    """
    Détecte la phase du marché sur les bougies récentes.
    """

    def __init__(self, config: Optional[PhaseDetectorConfig] = None) -> None:
        self.config = config or PhaseDetectorConfig()

    def detect(self, candles: list[Any]) -> PhaseResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 60):
            return PhaseResult(
                phase=MarketPhase.CHOP,
                trend="RANGE",
                strength=0,
                metrics={"reason": "not_enough_candles"},
            )

        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            return PhaseResult(
                phase=MarketPhase.CHOP,
                trend="RANGE",
                strength=0,
                atr=0.0,
                metrics={"reason": "atr_invalid"},
            )

        # ── Metrics windows ─────────────────────────────────────────────────
        imp_win = c[-cfg.impulse_window:] if len(c) >= cfg.impulse_window else c
        base_win = c[-cfg.base_window:] if len(c) >= cfg.base_window else c
        chop_win = c[-cfg.chop_window:] if len(c) >= cfg.chop_window else c

        imp = _impulse_metrics(imp_win, atr)
        base = _base_metrics(base_win, atr)
        chop = _chop_metrics(chop_win, atr)

        # ── Phase decisions ────────────────────────────────────────────────
        # 1) BASE (compression) prioritaire si elle est "propre"
        base_ok = (
            base["height_atr"] <= cfg.max_base_height_atr_mult
            and base["avg_range_atr"] <= cfg.max_base_avg_range_atr_mult
            and base["overlap"] >= cfg.min_base_overlap_ratio
            and base["directional_pct"] <= cfg.max_base_directional_pct
        )

        # 2) RALLY / DROP si impulsion forte
        rally_ok = (
            imp["net_atr"] >= cfg.min_impulse_net_atr_mult
            and imp["direction"] == "BULLISH"
            and imp["directional_pct"] >= cfg.min_impulse_directional_pct
            and imp["avg_range_atr"] >= cfg.min_impulse_avg_range_atr_mult
        )
        drop_ok = (
            imp["net_atr"] >= cfg.min_impulse_net_atr_mult
            and imp["direction"] == "BEARISH"
            and imp["directional_pct"] >= cfg.min_impulse_directional_pct
            and imp["avg_range_atr"] >= cfg.min_impulse_avg_range_atr_mult
        )

        # 3) CHOP si range "vivant" mais net move faible et biais directionnel faible
        chop_ok = (
            chop["net_atr"] <= cfg.max_chop_net_atr_mult
            and chop["avg_range_atr"] >= cfg.min_chop_volatility_atr_mult
            and chop["direction_bias"] <= cfg.max_chop_directional_bias
        )

        # ── Scoring (0..1) ─────────────────────────────────────────────────
        # Impulse score: net + directional
        impulse_score01 = _clip01(
            0.55 * _clip01(imp["net_atr"] / max(1e-9, cfg.min_impulse_net_atr_mult))
            + 0.45 * _clip01((imp["directional_pct"] - cfg.min_impulse_directional_pct) / max(1e-9, (1.0 - cfg.min_impulse_directional_pct)))
        )

        # Base score: tightness + overlap
        base_tight_score = _clip01(1.0 - base["height_atr"] / max(1e-9, cfg.max_base_height_atr_mult))
        base_rng_score = _clip01(1.0 - base["avg_range_atr"] / max(1e-9, cfg.max_base_avg_range_atr_mult))
        base_overlap_score = _clip01((base["overlap"] - cfg.min_base_overlap_ratio) / max(1e-9, (1.0 - cfg.min_base_overlap_ratio)))
        base_score01 = _clip01(0.45 * base_tight_score + 0.30 * base_rng_score + 0.25 * base_overlap_score)

        # Chop score: low net + low bias + decent vol
        chop_net_score = _clip01(1.0 - chop["net_atr"] / max(1e-9, cfg.max_chop_net_atr_mult))
        chop_bias_score = _clip01(1.0 - chop["direction_bias"] / max(1e-9, cfg.max_chop_directional_bias))
        chop_vol_score = _clip01(chop["avg_range_atr"] / max(1e-9, cfg.min_chop_volatility_atr_mult))
        chop_score01 = _clip01(0.45 * chop_net_score + 0.35 * chop_bias_score + 0.20 * chop_vol_score)

        # ── Choose phase ───────────────────────────────────────────────────
        phase = MarketPhase.CHOP
        trend = "RANGE"

        # priorité HLZ pratique : impulsion claire > base propre > chop
        if rally_ok:
            phase = MarketPhase.RALLY
            trend = "BULLISH"
        elif drop_ok:
            phase = MarketPhase.DROP
            trend = "BEARISH"
        elif base_ok:
            phase = MarketPhase.BASE
            trend = "RANGE"
        elif chop_ok:
            phase = MarketPhase.CHOP
            trend = "RANGE"
        else:
            # fallback : si net directionnel existe mais pas assez fort -> CHOP ou BASE selon compression
            if base["height_atr"] <= cfg.max_base_height_atr_mult * 1.35 and base["overlap"] >= cfg.min_base_overlap_ratio * 0.9:
                phase = MarketPhase.BASE
                trend = "RANGE"
            else:
                phase = MarketPhase.CHOP
                trend = "RANGE"

        # Strength (confiance) par phase choisie
        if phase in (MarketPhase.RALLY, MarketPhase.DROP):
            strength01 = _clip01(0.75 * impulse_score01 + 0.25 * (1.0 - base_score01))
        elif phase == MarketPhase.BASE:
            strength01 = _clip01(0.75 * base_score01 + 0.25 * (1.0 - impulse_score01))
        else:
            strength01 = _clip01(0.70 * chop_score01 + 0.30 * (1.0 - impulse_score01))

        strength = int(round(100 * strength01))

        return PhaseResult(
            phase=phase,
            trend=trend,
            strength=strength,
            atr=float(atr),
            metrics={
                "impulse": imp,
                "base": base,
                "chop": chop,
            },
            details={
                "rules": {
                    "rally_ok": rally_ok,
                    "drop_ok": drop_ok,
                    "base_ok": base_ok,
                    "chop_ok": chop_ok,
                },
                "scores01": {
                    "impulse": round(impulse_score01, 3),
                    "base": round(base_score01, 3),
                    "chop": round(chop_score01, 3),
                    "strength01": round(strength01, 3),
                },
                "config": {
                    "impulse_window": cfg.impulse_window,
                    "base_window": cfg.base_window,
                    "chop_window": cfg.chop_window,
                },
            },
        )


# ═════════════════════════════════════════════════════════════════════════════=
# Internals — metrics
# ═════════════════════════════════════════════════════════════════════════════=

def _impulse_metrics(win: list[Any], atr: float) -> dict[str, Any]:
    if not win:
        return {"direction": "", "net": 0.0, "net_atr": 0.0, "directional_pct": 0.0, "avg_range_atr": 0.0}

    o0 = _c_get(win[0], "open")
    cN = _c_get(win[-1], "close")
    net = cN - o0
    direction = "BULLISH" if net > 0 else "BEARISH" if net < 0 else ""

    bulls = sum(1 for x in win if _is_bull(x))
    bears = sum(1 for x in win if _is_bear(x))
    directional_pct = max(bulls, bears) / len(win)

    avg_rng = sum(_range(x) for x in win) / len(win)

    return {
        "direction": direction,
        "net": net,
        "net_atr": abs(net) / atr if atr > 0 else 0.0,
        "directional_pct": round(directional_pct, 3),
        "avg_range": avg_rng,
        "avg_range_atr": avg_rng / atr if atr > 0 else 0.0,
        "len": len(win),
    }


def _base_metrics(win: list[Any], atr: float) -> dict[str, Any]:
    if not win:
        return {"height": 0.0, "height_atr": 0.0, "avg_range_atr": 0.0, "overlap": 0.0, "directional_pct": 0.0}

    highs = [_c_get(x, "high") for x in win]
    lows = [_c_get(x, "low") for x in win]
    top = max(highs)
    bot = min(lows)
    height = max(0.0, top - bot)
    avg_rng = sum(_range(x) for x in win) / len(win)

    bulls = sum(1 for x in win if _is_bull(x))
    bears = sum(1 for x in win if _is_bear(x))
    directional_pct = max(bulls, bears) / len(win)

    ov = _overlap_ratio(win)

    return {
        "top": top,
        "bot": bot,
        "height": height,
        "height_atr": height / atr if atr > 0 else 0.0,
        "avg_range": avg_rng,
        "avg_range_atr": avg_rng / atr if atr > 0 else 0.0,
        "overlap": round(ov, 3),
        "directional_pct": round(directional_pct, 3),
        "len": len(win),
    }


def _chop_metrics(win: list[Any], atr: float) -> dict[str, Any]:
    if not win:
        return {"net_atr": 0.0, "avg_range_atr": 0.0, "direction_bias": 1.0}

    o0 = _c_get(win[0], "open")
    cN = _c_get(win[-1], "close")
    net = cN - o0

    bulls = sum(1 for x in win if _is_bull(x))
    bears = sum(1 for x in win if _is_bear(x))
    bull_frac = bulls / len(win)
    bear_frac = bears / len(win)
    bias = abs(bull_frac - bear_frac)

    avg_rng = sum(_range(x) for x in win) / len(win)

    return {
        "net": net,
        "net_atr": abs(net) / atr if atr > 0 else 0.0,
        "avg_range": avg_rng,
        "avg_range_atr": avg_rng / atr if atr > 0 else 0.0,
        "bull_frac": round(bull_frac, 3),
        "bear_frac": round(bear_frac, 3),
        "direction_bias": round(bias, 3),
        "len": len(win),
    }
