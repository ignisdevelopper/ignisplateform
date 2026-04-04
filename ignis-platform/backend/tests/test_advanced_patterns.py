# tests/test_advanced_patterns.py

from __future__ import annotations

import math

import pytest

from app.core.advanced_patterns.over_under import OverUnderDetector
from app.core.advanced_patterns.iou_detector import IOUDetector
from app.core.advanced_patterns.flag_limit import FlagLimitDetector
from app.core.advanced_patterns.counter_attack import CounterAttackDetector
from app.core.advanced_patterns.ignored_accu import IgnoredAccuDetector


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def mk_candle(o: float, c: float, wick: float = 0.3) -> dict:
    """
    Simple candle builder:
    - high/low around open/close with constant wick.
    """
    hi = max(o, c) + wick
    lo = min(o, c) - wick
    return {"open": float(o), "high": float(hi), "low": float(lo), "close": float(c)}


def build_series_from_closes(closes: list[float], wick: float = 0.3) -> list[dict]:
    """
    Convert a close series into OHLC candles (open = prev close).
    """
    assert len(closes) >= 2
    candles: list[dict] = []
    prev = closes[0]
    for c in closes[1:]:
        candles.append(mk_candle(prev, c, wick=wick))
        prev = c
    return candles


def add_flat_prefix(candles: list[dict], n: int = 20, price: float = 102.0) -> list[dict]:
    """
    Adds a flat regime prefix to stabilize ATR.
    """
    out: list[dict] = []
    prev = price
    for _ in range(n):
        out.append(mk_candle(prev, prev, wick=0.25))
    out.extend(candles)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────────────

def test_over_under_bullish_with_golden_zone():
    zone = {"zone_top": 101.0, "zone_bot": 100.0, "zone_type": "DEMAND"}

    # Stable prefix (ATR ~ small but > 0)
    closes = [103.0, 103.0, 103.0, 103.0, 103.0]
    candles = build_series_from_closes(closes, wick=0.25)

    # Sweep candle (low well under zone_bot), then reclaim candle (close above zone_top)
    # We craft explicitly to be sure:
    candles += [
        {"open": 103.0, "high": 103.2, "low": 99.5, "close": 100.6},  # sweep under
        {"open": 100.6, "high": 101.4, "low": 100.4, "close": 101.2},  # reclaim over
        {"open": 101.2, "high": 101.3, "low": 100.70, "close": 101.05},  # pullback low into golden zone
        mk_candle(101.05, 101.15, wick=0.2),
    ]
    candles = add_flat_prefix(candles, n=30, price=103.0)

    det = OverUnderDetector()
    res = det.detect(candles, zone)

    assert res.detected is True
    assert res.direction == "BULLISH"
    assert res.golden_zone is True
    assert res.strength >= 60
    assert res.sweep_index is not None
    assert res.reclaim_index is not None
    assert res.golden_zone_hit_index is not None


def test_iou_bullish_ou_ignored_becomes_bearish():
    zone = {"zone_top": 101.0, "zone_bot": 100.0, "zone_type": "DEMAND"}

    candles = add_flat_prefix(build_series_from_closes([103.0, 103.0, 103.0, 103.0, 103.0], wick=0.25), n=30, price=103.0)
    candles += [
        {"open": 103.0, "high": 103.2, "low": 99.5, "close": 100.6},   # sweep under
        {"open": 100.6, "high": 101.5, "low": 100.4, "close": 101.25}, # reclaim over
        {"open": 101.25, "high": 101.3, "low": 99.2, "close": 99.4},   # ignore: close below zone_bot
        mk_candle(99.4, 99.6, wick=0.2),
    ]

    det = IOUDetector()
    res = det.detect(candles, zone)

    assert res.detected is True
    assert res.ou_direction == "BULLISH"
    assert res.direction == "BEARISH"  # IOU direction is opposite of OU
    assert res.strength >= 60
    assert res.sweep_index is not None
    assert res.reclaim_index is not None
    assert res.ignore_index is not None


def test_flag_limit_bullish_detected():
    # Prefix
    candles = add_flat_prefix(build_series_from_closes([100, 100, 100, 100, 100], wick=0.25), n=25, price=100.0)

    # Strong bullish impulse (net move big)
    impulse_closes = [100.0, 101.2, 102.4, 103.6, 104.8, 105.4]
    candles += build_series_from_closes(impulse_closes, wick=0.35)

    # Tight flag (small height, overlap)
    flag = [
        mk_candle(105.4, 105.0, wick=0.25),
        mk_candle(105.0, 105.2, wick=0.25),
        mk_candle(105.2, 104.9, wick=0.25),
        mk_candle(104.9, 105.1, wick=0.25),
        mk_candle(105.1, 105.0, wick=0.25),
        mk_candle(105.0, 105.15, wick=0.25),
    ]
    candles += flag

    det = FlagLimitDetector()
    res = det.detect(candles)

    assert res.detected is True
    assert res.direction in ("BULLISH", "BEARISH")
    assert res.direction == "BULLISH"
    assert res.flag_high is not None and res.flag_low is not None
    assert res.limit_price is not None
    assert res.strength >= 55


def test_counter_attack_bullish_from_demand_zone():
    zone = {"zone_top": 101.0, "zone_bot": 100.0, "zone_type": "DEMAND"}

    # Prefix
    candles = add_flat_prefix(build_series_from_closes([104, 104, 104, 104, 104], wick=0.25), n=25, price=104.0)

    # Impulse down into zone (bearish candles)
    candles += [
        mk_candle(104.0, 103.2, wick=0.35),
        mk_candle(103.2, 102.3, wick=0.35),
        mk_candle(102.3, 101.4, wick=0.35),
        mk_candle(101.4, 100.6, wick=0.35),
    ]

    # Rejection candle in zone with long lower wick and close above zone_top
    candles += [
        {"open": 100.8, "high": 101.4, "low": 99.6, "close": 101.3},
        mk_candle(101.3, 101.35, wick=0.2),
    ]

    det = CounterAttackDetector()
    res = det.detect(candles, zone)

    assert res.detected is True
    assert res.direction == "BULLISH"
    assert res.strength >= 60
    assert res.rejection_index is not None
    assert res.trigger_price is not None


def test_ignored_accu_detected_demand_case():
    """
    Build a decreasing swing-high staircase (lower highs) approaching demand zone,
    then a fake break UP away from the zone, then quick return to touch the zone.
    """
    zone = {"zone_top": 101.0, "zone_bot": 100.0, "zone_type": "DEMAND"}

    # A synthetic close path designed to create swing highs at indices ~3,7,11
    closes = [
        110.0,
        108.0,
        106.0,
        107.5,  # peak 1
        106.5,
        105.5,
        104.5,
        105.8,  # peak 2 (lower)
        104.8,
        103.8,
        102.8,
        104.0,  # peak 3 (lower)
        103.0,
        102.0,
        101.2,
        101.9,
        101.0,
        100.8,  # near zone
        105.2,  # fake break away UP (ignored)
        102.2,
        100.7,  # back to zone quickly (hit)
        101.0,
    ]
    candles = build_series_from_closes(closes, wick=0.35)
    candles = add_flat_prefix(candles, n=30, price=110.0)

    det = IgnoredAccuDetector()
    res = det.detect(candles, zone)

    assert res.detected is True
    assert res.direction == "BULLISH"
    assert res.steps >= 3
    assert res.break_index is not None
    assert res.zone_hit_index is not None
    assert res.strength >= 45  # keep tolerant, pattern depends on ATR/swing exactness


@pytest.mark.parametrize(
    "detector_cls, detector_args",
    [
        (OverUnderDetector, {}),
        (IOUDetector, {}),
        (CounterAttackDetector, {}),
        (IgnoredAccuDetector, {}),
    ],
)
def test_advanced_patterns_require_zone(detector_cls, detector_args):
    candles = add_flat_prefix(build_series_from_closes([100, 100, 100, 100, 100], wick=0.25), n=25, price=100.0)
    det = detector_cls(**detector_args)  # type: ignore

    # All these detectors were designed zone-required (our implementation)
    res = det.detect(candles, None)  # type: ignore
    assert getattr(res, "detected", False) is False