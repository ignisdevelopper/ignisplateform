# tests/test_market_structure.py

from __future__ import annotations

import pytest

from app import MarketPhase
from app.core.market_structure.phase_detector import PhaseDetector
from app.core.market_structure.swing_detector import SwingDetector
from app.core.market_structure.structure_breaker import StructureBreaker


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def mk_candle(o: float, c: float, *, up_wick: float = 0.3, dn_wick: float = 0.3) -> dict:
    hi = max(o, c) + up_wick
    lo = min(o, c) - dn_wick
    return {"open": float(o), "high": float(hi), "low": float(lo), "close": float(c)}


def add_flat_prefix(n: int = 30, price: float = 100.0) -> list[dict]:
    return [mk_candle(price, price, up_wick=0.25, dn_wick=0.25) for _ in range(n)]


def build_rally_series() -> list[dict]:
    candles = add_flat_prefix(40, 100.0)
    # Strong bullish impulse
    candles += [
        mk_candle(100.0, 101.5, up_wick=0.8, dn_wick=0.35),
        mk_candle(101.5, 103.0, up_wick=0.8, dn_wick=0.35),
        mk_candle(103.0, 104.4, up_wick=0.8, dn_wick=0.35),
        mk_candle(104.4, 106.0, up_wick=0.8, dn_wick=0.35),
        mk_candle(106.0, 107.3, up_wick=0.8, dn_wick=0.35),
        mk_candle(107.3, 108.6, up_wick=0.8, dn_wick=0.35),
    ]
    return candles


def build_drop_series() -> list[dict]:
    candles = add_flat_prefix(40, 110.0)
    candles += [
        mk_candle(110.0, 108.8, up_wick=0.35, dn_wick=0.8),
        mk_candle(108.8, 107.4, up_wick=0.35, dn_wick=0.8),
        mk_candle(107.4, 106.0, up_wick=0.35, dn_wick=0.8),
        mk_candle(106.0, 104.5, up_wick=0.35, dn_wick=0.8),
        mk_candle(104.5, 103.2, up_wick=0.35, dn_wick=0.8),
        mk_candle(103.2, 102.0, up_wick=0.35, dn_wick=0.8),
    ]
    return candles


def build_base_series() -> list[dict]:
    candles = add_flat_prefix(40, 100.0)
    # tight consolidation around 100
    candles += [
        mk_candle(100.0, 99.9, up_wick=0.15, dn_wick=0.15),
        mk_candle(99.9, 100.1, up_wick=0.15, dn_wick=0.15),
        mk_candle(100.1, 100.0, up_wick=0.15, dn_wick=0.15),
        mk_candle(100.0, 100.05, up_wick=0.15, dn_wick=0.15),
        mk_candle(100.05, 99.95, up_wick=0.15, dn_wick=0.15),
        mk_candle(99.95, 100.0, up_wick=0.15, dn_wick=0.15),
        mk_candle(100.0, 100.08, up_wick=0.15, dn_wick=0.15),
        mk_candle(100.08, 100.0, up_wick=0.15, dn_wick=0.15),
    ]
    return candles


def build_sb_bullish_series() -> list[dict]:
    """
    Create a swing high then break above it with a strong close.
    """
    candles = add_flat_prefix(50, 100.0)

    # build a small structure with a swing high around 103
    candles += [
        mk_candle(100.0, 101.5, up_wick=0.6, dn_wick=0.3),
        mk_candle(101.5, 102.5, up_wick=0.6, dn_wick=0.3),
        mk_candle(102.5, 101.8, up_wick=0.4, dn_wick=0.4),
        mk_candle(101.8, 103.2, up_wick=0.7, dn_wick=0.3),  # likely swing high
        mk_candle(103.2, 102.0, up_wick=0.4, dn_wick=0.5),
        mk_candle(102.0, 101.0, up_wick=0.3, dn_wick=0.6),

        # rally and break above swing high
        {"open": 101.0, "high": 104.5, "low": 100.9, "close": 104.2},
        mk_candle(104.2, 104.4, up_wick=0.25, dn_wick=0.25),
    ]
    return candles


# ─────────────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────────────

def test_phase_detector_rally():
    candles = build_rally_series()
    det = PhaseDetector()
    res = det.detect(candles)

    assert res.phase in (MarketPhase.RALLY, MarketPhase.CHOP, MarketPhase.BASE)
    assert res.phase == MarketPhase.RALLY
    assert res.trend == "BULLISH"
    assert 0 <= res.strength <= 100


def test_phase_detector_drop():
    candles = build_drop_series()
    det = PhaseDetector()
    res = det.detect(candles)

    assert res.phase == MarketPhase.DROP
    assert res.trend == "BEARISH"
    assert 0 <= res.strength <= 100


def test_phase_detector_base():
    candles = build_base_series()
    det = PhaseDetector()
    res = det.detect(candles)

    assert res.phase in (MarketPhase.BASE, MarketPhase.CHOP)
    assert res.phase == MarketPhase.BASE
    assert res.trend == "RANGE"
    assert 0 <= res.strength <= 100


def test_swing_detector_outputs_structure():
    candles = build_rally_series()
    det = SwingDetector()
    res = det.detect(candles)

    assert res.detected is True
    assert res.trend in ("BULLISH", "BEARISH", "RANGE")
    assert isinstance(res.swing_points, list)
    # Might not always be HH/HL with synthetic data, but should exist
    assert res.confidence >= 0


def test_structure_breaker_bullish_sb():
    candles = build_sb_bullish_series()
    sb = StructureBreaker()
    res = sb.detect(candles)

    # With synthetic candles, this should break swing high
    assert res.detected is True
    assert res.direction in ("BULLISH", "BEARISH")
    assert res.direction == "BULLISH"
    assert res.broken_level is not None
    assert res.break_index is not None
    assert res.strength >= 40