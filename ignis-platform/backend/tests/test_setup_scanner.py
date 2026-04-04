# tests/test_setup_scanner.py

from __future__ import annotations

import pytest

from app import SetupStatus
from app.core.setup_scanner.setup_pipeline import SetupPipeline, SetupPipelineConfig


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def mk_candle(o: float, c: float, *, up_wick: float = 0.35, dn_wick: float = 0.35, high=None, low=None) -> dict:
    hi = float(high) if high is not None else max(o, c) + up_wick
    lo = float(low) if low is not None else min(o, c) - dn_wick
    return {"open": float(o), "high": float(hi), "low": float(lo), "close": float(c)}


def add_flat_prefix(n: int = 80, price: float = 100.0) -> list[dict]:
    return [mk_candle(price, price, up_wick=0.25, dn_wick=0.25) for _ in range(n)]


def build_end_to_end_scenario() -> list[dict]:
    """
    Construit un scénario synthétique "assez propre" pour produire :
    - une base (DBR/RBR)
    - une SDE bullish
    - une zone SGB demand
    - un FTB (fresh ou approaching)
    - (option) un SDP selon la réaction

    Comme c'est du synthétique, on teste surtout que le pipeline tourne et que
    les blocs sont présents/cohérents.
    """
    candles: list[dict] = []
    candles += add_flat_prefix(120, 100.0)

    # Impulse down
    candles += [
        mk_candle(100.0, 99.0, up_wick=0.4, dn_wick=0.8),
        mk_candle(99.0, 98.2, up_wick=0.4, dn_wick=0.8),
        mk_candle(98.2, 97.5, up_wick=0.4, dn_wick=0.8),
        mk_candle(97.5, 97.1, up_wick=0.35, dn_wick=0.7),
    ]

    # Tight base
    candles += [
        mk_candle(97.1, 97.2, up_wick=0.12, dn_wick=0.22, low=96.90),
        mk_candle(97.2, 97.15, up_wick=0.12, dn_wick=0.18),
        mk_candle(97.15, 97.25, up_wick=0.12, dn_wick=0.18),
        mk_candle(97.25, 97.20, up_wick=0.12, dn_wick=0.18),
    ]

    # SDE bullish + departure
    candles += [
        mk_candle(97.20, 98.70, high=99.10, low=96.75),
        mk_candle(98.70, 99.70, up_wick=0.6, dn_wick=0.35),
        mk_candle(99.70, 100.80, up_wick=0.6, dn_wick=0.35),
        mk_candle(100.80, 101.60, up_wick=0.6, dn_wick=0.35),
        mk_candle(101.60, 102.10, up_wick=0.35, dn_wick=0.25),
    ]

    # Pullback close to zone (approaching)
    candles += [
        mk_candle(102.10, 101.40, up_wick=0.25, dn_wick=0.45),
        mk_candle(101.40, 100.95, up_wick=0.25, dn_wick=0.55),
        mk_candle(100.95, 101.10, up_wick=0.25, dn_wick=0.45),
    ]

    return candles


# ─────────────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────────────

def test_setup_pipeline_smoke_end_to_end():
    candles = build_end_to_end_scenario()

    pipeline = SetupPipeline(SetupPipelineConfig(
        candle_limit=500,
        use_cache=False,
        enable_advanced_patterns=True,
        enable_pa_patterns=True,
        enable_decision_points=True,
        enable_sl_tp=True,
        enable_pullback_entry=True,
    ))

    res = pipeline.run_from_candles(symbol="BTCUSDT", timeframe="H4", candles=candles)
    d = res.to_dict()

    assert d["symbol"] == "BTCUSDT"
    assert d["timeframe"] == "H4"
    assert d["candle_count"] == len(candles)

    # Blocks exist
    assert "market_structure" in d
    assert "base" in d
    assert "sd_zone" in d
    assert "setup" in d

    # Setup status should be one of defined enums
    status = (d["setup"] or {}).get("status")
    assert status in (
        SetupStatus.VALID,
        SetupStatus.PENDING,
        SetupStatus.INVALID,
        SetupStatus.WATCH,
        SetupStatus.EXPIRED,
    )

    # If zone exists, it should have bounds
    zone = (d.get("sd_zone", {}) or {}).get("zone", {}) or {}
    if zone:
        assert zone.get("zone_top") is not None
        assert zone.get("zone_bot") is not None
        assert zone.get("zone_top") >= zone.get("zone_bot")

    # No hard crash errors
    assert isinstance(d.get("errors", []), list)


def test_setup_pipeline_returns_watch_on_empty_or_bad_data():
    pipeline = SetupPipeline(SetupPipelineConfig(use_cache=False))

    res = pipeline.run_from_candles(symbol="BTCUSDT", timeframe="H4", candles=[])
    d = res.to_dict()

    assert d["setup"]["status"] in (SetupStatus.INVALID, SetupStatus.WATCH)
    assert d["candle_count"] == 0
    assert len(d.get("errors", [])) >= 1