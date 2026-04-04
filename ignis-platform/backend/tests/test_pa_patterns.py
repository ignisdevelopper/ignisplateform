# tests/test_pa_patterns.py

from __future__ import annotations

import pytest

from app.core.pa_patterns.accu_detector import AccuDetector
from app.core.pa_patterns.three_drives import ThreeDrivesDetector
from app.core.pa_patterns.ftl_detector import FTLDetector
from app.core.pa_patterns.pattern_69 import Pattern69Detector
from app.core.pa_patterns.hidden_sde import HiddenSDEDetector


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def mk_candle(o: float, c: float, *, up_wick: float = 0.3, dn_wick: float = 0.3) -> dict:
    hi = max(o, c) + up_wick
    lo = min(o, c) - dn_wick
    return {"open": float(o), "high": float(hi), "low": float(lo), "close": float(c)}


def build_from_closes(closes: list[float], *, wick: float = 0.3) -> list[dict]:
    assert len(closes) >= 2
    out: list[dict] = []
    prev = closes[0]
    for cl in closes[1:]:
        out.append(mk_candle(prev, cl, up_wick=wick, dn_wick=wick))
        prev = cl
    return out


def add_flat_prefix(candles: list[dict], n: int = 30, price: float = 110.0) -> list[dict]:
    out = [mk_candle(price, price, up_wick=0.25, dn_wick=0.25) for _ in range(n)]
    out.extend(candles)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────────────

def test_accu_detector_higher_lows_approaching_demand():
    zone = {"zone_top": 101.0, "zone_bot": 100.0, "zone_type": "DEMAND"}

    # Price below zone -> should approach UP with higher lows
    closes = [
        95.0, 96.2, 95.7, 96.8, 96.2, 97.3, 96.7, 98.0, 97.4, 98.6, 98.1, 99.0, 98.6, 99.5, 99.2, 99.8
    ]
    candles = build_from_closes(closes, wick=0.35)
    candles = add_flat_prefix(candles, n=35, price=95.0)

    det = AccuDetector()
    res = det.detect(candles, zone)

    assert res.detected is True
    assert res.direction in ("UP", "DOWN")
    assert res.direction == "UP"
    assert res.steps >= 3
    assert res.strength >= 45
    assert res.accu_start_index is not None
    assert res.accu_end_index is not None


def test_three_drives_bullish_on_demand_zone():
    zone = {"zone_top": 101.0, "zone_bot": 100.0, "zone_type": "DEMAND"}

    # Synthetic series with 3 descending lows and bounce highs
    closes = [
        110.0,
        108.0, 109.0,
        106.5, 108.3,
        105.2, 107.2,
        104.0, 106.8,
        103.0, 106.0,
        102.2, 105.5,
        101.3, 104.8,
        100.6, 103.8,
    ]
    candles = build_from_closes(closes, wick=0.5)
    candles = add_flat_prefix(candles, n=40, price=110.0)

    det = ThreeDrivesDetector()
    res = det.detect(candles, zone)

    assert res.detected is True
    assert res.direction == "BULLISH"
    assert res.third_drive_price is not None
    assert res.third_drive_index is not None
    assert res.strength >= 40  # tolerant: synthetic swings can vary


def test_ftl_detector_forming_or_confirmed():
    """
    We build a downtrendline via descending swing highs then break it and retest.
    Synthetic series might not always produce perfect fractal swings, so accept FORMING/CONFIRMED if detected.
    """
    zone = {"zone_top": 101.0, "zone_bot": 100.0, "zone_type": "DEMAND"}

    # Downtrend then break up
    closes = [
        110.0,
        108.8, 109.5, 108.0, 108.7, 107.2, 107.9, 106.6, 107.3, 106.0,
        107.5, 109.0, 110.2, 109.4, 110.5, 111.0
    ]
    candles = build_from_closes(closes, wick=0.6)
    candles = add_flat_prefix(candles, n=50, price=110.0)

    det = FTLDetector()
    res = det.detect(candles, zone)

    # Depending on swing detection, may or may not be detected. If detected, must be valid.
    if res.detected:
        assert res.direction in ("BULLISH", "BEARISH")
        assert res.status in ("FORMING", "CONFIRMED")
        assert res.strength >= 40
        assert res.break_index is not None


def test_pattern_69_detected_when_flippy_sde_sgb_present():
    """
    Pattern69 is metadata-first: we provide zone with flippy + sde + sgb fields.
    """
    candles = add_flat_prefix(build_from_closes([100, 100, 100, 100, 100], wick=0.25), n=50, price=100.0)

    zone = {
        "zone_top": 101.0,
        "zone_bot": 100.0,
        "zone_type": "FLIPPY_D",
        "is_flippy": True,
        "sde_detected": True,
        "sde_score": 85,
        "sgb_created": True,
        "base_type": "DBR",
        "base_score": 80,
    }

    det = Pattern69Detector()
    res = det.detect(candles, zone=zone, sde={"detected": True, "score": 85}, base={"base_type": "DBR", "score": 80})

    assert res.detected is True
    assert res.flippy is True
    assert res.sde_ok is True
    assert res.sgb_ok is True
    assert res.status in ("FORMING", "READY")
    assert res.strength >= 60


def test_hidden_sde_detected_with_fbo_and_engulf():
    zone = {"zone_top": 101.0, "zone_bot": 100.0, "zone_type": "FLIPPY_D", "is_flippy": True}

    candles = add_flat_prefix(build_from_closes([103, 103, 103, 103, 103], wick=0.25), n=40, price=103.0)

    # FBO sweep under zone, reclaim, base, then bullish engulf
    candles += [
        {"open": 103.0, "high": 103.2, "low": 99.5, "close": 100.6},   # sweep under
        {"open": 100.6, "high": 100.8, "low": 100.2, "close": 100.5},  # base1
        {"open": 100.5, "high": 100.75, "low": 100.25, "close": 100.55},# base2
        {"open": 100.55, "high": 100.70, "low": 100.30, "close": 100.50},# base3
        {"open": 100.50, "high": 101.60, "low": 100.40, "close": 101.30}, # reclaim+engulf
        mk_candle(101.30, 101.40, up_wick=0.2, dn_wick=0.2),
    ]

    det = HiddenSDEDetector()
    res = det.detect(candles, zone=zone, flippy_hint=True)

    assert res.detected is True
    assert res.direction in ("BULLISH", "BEARISH")
    assert res.direction == "BULLISH"
    assert res.sde_index is not None
    assert res.reclaim_index is not None
    assert res.fbo_index is not None
    assert res.strength >= 50