# tests/test_base_engine.py

from __future__ import annotations

import pytest

from app import BaseType
from app.core.base_engine.base_detector import BaseDetector
from app.core.base_engine.base_scorer import BaseScorer
from app.core.base_engine.weakening_base import WeakeningBaseDetector
from app.core.base_engine.hidden_base import HiddenBaseDetector


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def mk_candle(o: float, c: float, *, up_wick: float = 0.3, dn_wick: float = 0.3) -> dict:
    hi = max(o, c) + up_wick
    lo = min(o, c) - dn_wick
    return {"open": float(o), "high": float(hi), "low": float(lo), "close": float(c)}


def build_from_closes(
    closes: list[float],
    *,
    up_wick: float = 0.3,
    dn_wick: float = 0.3,
) -> list[dict]:
    """
    open = previous close
    """
    assert len(closes) >= 2
    out: list[dict] = []
    prev = closes[0]
    for cl in closes[1:]:
        out.append(mk_candle(prev, cl, up_wick=up_wick, dn_wick=dn_wick))
        prev = cl
    return out


def add_flat_prefix(candles: list[dict], n: int = 25, price: float = 100.0) -> list[dict]:
    out: list[dict] = []
    for _ in range(n):
        out.append(mk_candle(price, price, up_wick=0.25, dn_wick=0.25))
    out.extend(candles)
    return out


def build_rbr_scenario() -> list[dict]:
    """
    Rally -> Base -> Rally
    """
    candles: list[dict] = []
    candles = add_flat_prefix(candles, n=30, price=100.0)

    # Pre-impulse up (bigger ranges)
    candles += [
        mk_candle(100.0, 101.2, up_wick=0.7, dn_wick=0.35),
        mk_candle(101.2, 102.3, up_wick=0.7, dn_wick=0.35),
        mk_candle(102.3, 103.2, up_wick=0.7, dn_wick=0.35),
        mk_candle(103.2, 104.0, up_wick=0.7, dn_wick=0.35),
    ]

    # Tight base (small overlap)
    candles += [
        mk_candle(104.0, 103.8, up_wick=0.15, dn_wick=0.15),
        mk_candle(103.8, 104.05, up_wick=0.15, dn_wick=0.15),
        mk_candle(104.05, 103.95, up_wick=0.15, dn_wick=0.15),
        mk_candle(103.95, 104.10, up_wick=0.15, dn_wick=0.15),
    ]

    # Post-impulse up (bigger ranges)
    candles += [
        mk_candle(104.10, 105.1, up_wick=0.75, dn_wick=0.35),
        mk_candle(105.1, 106.0, up_wick=0.75, dn_wick=0.35),
        mk_candle(106.0, 106.7, up_wick=0.75, dn_wick=0.35),
        mk_candle(106.7, 107.4, up_wick=0.75, dn_wick=0.35),
    ]

    return candles


# ─────────────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────────────

def test_base_detector_detects_rbr():
    candles = build_rbr_scenario()

    det = BaseDetector()
    res = det.detect(candles)

    assert res.detected is True
    assert res.base_type == BaseType.RBR
    assert res.base_start_index is not None
    assert res.base_end_index is not None
    assert res.base_top is not None
    assert res.base_bot is not None
    assert res.strength >= 50


def test_base_scorer_returns_reasonable_score():
    candles = build_rbr_scenario()

    det = BaseDetector()
    base = det.detect(candles)
    assert base.detected is True

    scorer = BaseScorer()
    score = scorer.score(candles, base)

    assert score.score >= 40
    assert score.score <= 100
    assert score.grade in ("A", "B", "C", "D")
    assert score.base_top is not None
    assert score.base_bot is not None
    assert score.touches >= 0


def test_weakening_base_detects_multiple_touches():
    candles = build_rbr_scenario()

    det = BaseDetector()
    base = det.detect(candles)
    assert base.detected is True
    assert base.base_top is not None and base.base_bot is not None

    # Add multiple retests after the departure, without invalidating the base
    # For bullish departure bases, WB treats it as DEMAND and checks close < base_bot - buffer for invalidation.
    bt = float(base.base_top)
    bb = float(base.base_bot)

    # drive away up then return to touch base several times
    candles += [
        mk_candle(candles[-1]["close"], bt + 2.5, up_wick=0.8, dn_wick=0.4),
        mk_candle(bt + 2.5, bt + 1.0, up_wick=0.4, dn_wick=0.4),

        # Touch #1 cluster
        {"open": bt + 1.0, "high": bt + 1.2, "low": bb + 0.05, "close": bt + 0.9},
        mk_candle(bt + 0.9, bt + 1.4, up_wick=0.35, dn_wick=0.25),

        # Touch #2 cluster
        mk_candle(bt + 1.4, bt + 0.8, up_wick=0.3, dn_wick=0.35),
        {"open": bt + 0.8, "high": bt + 1.0, "low": bb + 0.02, "close": bt + 0.85},
        mk_candle(bt + 0.85, bt + 1.1, up_wick=0.3, dn_wick=0.25),

        # Touch #3 cluster
        mk_candle(bt + 1.1, bt + 0.7, up_wick=0.3, dn_wick=0.35),
        {"open": bt + 0.7, "high": bt + 0.95, "low": bb + 0.01, "close": bt + 0.75},
        mk_candle(bt + 0.75, bt + 1.0, up_wick=0.25, dn_wick=0.25),
    ]

    wb = WeakeningBaseDetector()
    wb_res = wb.detect(candles, base)

    assert wb_res.touches >= 3
    assert wb_res.weakened is True
    assert wb_res.side in ("DEMAND", "SUPPLY")
    assert wb_res.invalidated in (True, False)


def test_hidden_base_kissing_lows_detected():
    # Stable prefix for ATR
    candles = add_flat_prefix([], n=40, price=102.0)

    # Create a micro-base with "kissing lows" around 100.00
    # then a bullish departure
    candles += [
        mk_candle(102.0, 101.0, up_wick=0.4, dn_wick=0.6),
        mk_candle(101.0, 100.3, up_wick=0.35, dn_wick=0.55),

        # micro-base (tight) with kissing lows
        {"open": 100.3, "high": 100.6, "low": 100.00, "close": 100.25},
        {"open": 100.25, "high": 100.55, "low": 100.02, "close": 100.30},
        {"open": 100.30, "high": 100.60, "low": 100.01, "close": 100.28},

        # departure up
        {"open": 100.28, "high": 101.4, "low": 100.20, "close": 101.2},
        mk_candle(101.2, 101.7, up_wick=0.35, dn_wick=0.25),
        mk_candle(101.7, 102.0, up_wick=0.25, dn_wick=0.25),
    ]

    # Optional reference zone around the micro-base (helps proximity score)
    zone = {"zone_top": 100.60, "zone_bot": 99.90, "zone_type": "DEMAND"}

    hb = HiddenBaseDetector()
    hb_res = hb.detect(candles, reference_zone=zone, direction_hint="BULLISH")

    assert hb_res.detected is True
    assert hb_res.hidden_type in ("HIDDEN_D", "HIDDEN_S")
    assert hb_res.hidden_type == "HIDDEN_D"
    assert hb_res.kiss_count >= 2
    assert hb_res.strength >= 50
    assert hb_res.base_top is not None and hb_res.base_bot is not None