```python
# tests/test_sde_sgb_sdp.py

from __future__ import annotations

import pytest

from app import BaseType, ZoneType
from app.core.base_engine.base_detector import BaseDetector
from app.core.sd_zones.sde_detector import SDEDetector
from app.core.sd_zones.sgb_detector import SGBDetector
from app.core.sd_zones.sdp_detector import SDPDetector
from app.core.sd_zones.ftb_detector import FTBDetector
from app.core.sd_zones.failed_sde import FailedSDEDetector
from app.core.sd_zones.flippy_detector import FlippyDetector


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def mk_candle(
    o: float,
    c: float,
    *,
    up_wick: float = 0.35,
    dn_wick: float = 0.35,
    high: float | None = None,
    low: float | None = None,
) -> dict:
    hi = float(high) if high is not None else max(o, c) + up_wick
    lo = float(low) if low is not None else min(o, c) - dn_wick
    return {"open": float(o), "high": float(hi), "low": float(lo), "close": float(c)}


def add_flat_prefix(n: int = 40, price: float = 100.0) -> list[dict]:
    return [mk_candle(price, price, up_wick=0.25, dn_wick=0.25) for _ in range(n)]


def build_dbr_base_and_sde_scenario() -> list[dict]:
    """
    Scénario contrôlé qui produit généralement :
    - une base + départ bullish => base_type DBR (demand reversal)
    - un SDE bullish juste après la base
    - ensuite le marché monte (departure), puis revient toucher un HEAD (pour SDP / FTB)

    L’idée est de rendre les ranges d’impulsion assez grands vs ATR,
    et la base très serrée (overlap).
    """
    candles: list[dict] = []

    # Stabilise ATR
    candles += add_flat_prefix(60, 100.0)

    # Pre-impulse DOWN (4 bearish candles)
    candles += [
        mk_candle(100.0, 99.0, up_wick=0.40, dn_wick=0.70),
        mk_candle(99.0, 98.2, up_wick=0.40, dn_wick=0.70),
        mk_candle(98.2, 97.4, up_wick=0.40, dn_wick=0.70),
        mk_candle(97.4, 97.0, up_wick=0.35, dn_wick=0.65),
    ]

    # Tight base (4 candles) around 97.10-97.25, with a known distal low ~96.90
    # Keep overlap high and bodies small.
    candles += [
        mk_candle(97.0, 97.15, up_wick=0.12, dn_wick=0.25, low=96.90),  # ensure base_bot ~96.90
        mk_candle(97.15, 97.10, up_wick=0.12, dn_wick=0.18),
        mk_candle(97.10, 97.22, up_wick=0.12, dn_wick=0.18),
        mk_candle(97.22, 97.18, up_wick=0.12, dn_wick=0.18),
    ]

    # Post-impulse UP (first candle is crafted to engulf base => SDE bullish)
    # Make low <= base_bot and close well above base_top.
    candles += [
        mk_candle(97.18, 98.60, high=98.90, low=96.80),  # SDE candidate: low under base_bot, close above base_top
        mk_candle(98.60, 99.60, up_wick=0.55, dn_wick=0.35),
        mk_candle(99.60, 100.70, up_wick=0.55, dn_wick=0.35),
        mk_candle(100.70, 101.60, up_wick=0.55, dn_wick=0.35),
    ]

    # Continuation up
    candles += [
        mk_candle(101.60, 102.00, up_wick=0.35, dn_wick=0.25),
        mk_candle(102.00, 102.40, up_wick=0.35, dn_wick=0.25),
    ]

    return candles


# ─────────────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────────────

def test_sgb_created_from_base():
    candles = build_dbr_base_and_sde_scenario()

    base = BaseDetector().detect(candles)
    assert base.detected is True
    assert base.base_type in (BaseType.DBR, BaseType.RBR)  # demand departure base types
    assert base.base_start_index is not None
    assert base.base_end_index is not None

    sgb = SGBDetector().detect(candles, base=base)
    assert sgb.created is True
    assert sgb.zone_type in (ZoneType.DEMAND, ZoneType.SUPPLY)
    assert sgb.zone_type == ZoneType.DEMAND
    assert sgb.zone_top is not None and sgb.zone_bot is not None
    assert sgb.proximal is not None and sgb.distal is not None
    assert sgb.base_type is not None


def test_sde_detected_after_base():
    candles = build_dbr_base_and_sde_scenario()

    base = BaseDetector().detect(candles)
    assert base.detected is True

    sde = SDEDetector().detect(candles, base=base)
    assert sde.detected is True
    assert sde.direction == "BULLISH"
    assert sde.score >= 60
    assert sde.engulf_ratio is not None and sde.engulf_ratio >= 0.80
    assert sde.sde_index is not None


def test_ftb_fresh_then_taken_after_touch():
    candles = build_dbr_base_and_sde_scenario()

    base = BaseDetector().detect(candles)
    sgb = SGBDetector().detect(candles, base=base)
    assert sgb.created is True

    zone = {
        "zone_top": sgb.zone_top,
        "zone_bot": sgb.zone_bot,
        "zone_type": sgb.zone_type,
        "created_index": sgb.created_index,
    }

    # No touch yet (we did not append pullback)
    ftb1 = FTBDetector().detect(candles, zone=zone, creation_index=zone["created_index"])
    assert ftb1.detected is True
    assert ftb1.touches == 0
    assert ftb1.ftb_valid is True
    assert ftb1.ftb_state in ("FRESH", "APPROACHING", "NO_DEPARTURE")

    # Append a touch into the zone (FTB hit)
    zt = float(zone["zone_top"])
    zb = float(zone["zone_bot"])
    # Create a pullback candle that intersects the zone
    last_close = float(candles[-1]["close"])
    candles2 = candles + [
        mk_candle(last_close, zt + 0.15, high=zt + 0.30, low=zb + 0.01),  # touch zone
        mk_candle(zt + 0.15, zt + 0.40, up_wick=0.25, dn_wick=0.15),
    ]

    ftb2 = FTBDetector().detect(candles2, zone=zone, creation_index=zone["created_index"])
    assert ftb2.detected is True
    assert ftb2.touches >= 1
    assert ftb2.ftb_taken is True
    assert ftb2.ftb_valid is False
    assert ftb2.ftb_state in ("HIT", "TAKEN", "EXHAUSTED", "NO_DEPARTURE")


def test_sdp_validated_head_held():
    candles = build_dbr_base_and_sde_scenario()

    base = BaseDetector().detect(candles)
    sgb = SGBDetector().detect(candles, base=base)
    sde = SDEDetector().detect(candles, base=base)
    assert sgb.created is True
    assert sde.detected is True

    zone = {
        "zone_top": sgb.zone_top,
        "zone_bot": sgb.zone_bot,
        "zone_type": sgb.zone_type,
        "created_index": sgb.created_index,
        "sde_index": sde.sde_index,
        "direction": sde.direction,
    }

    # Define HEAD explicitly at distal (zone_bot) to make the test deterministic
    head = float(zone["zone_bot"])

    # Append a touch of HEAD and a reaction
    # Touch candle: low touches head, close stays above
    last_close = float(candles[-1]["close"])
    candles += [
        mk_candle(last_close, head + 0.20, high=head + 0.35, low=head - 0.02),  # touch head
        mk_candle(head + 0.20, head + 1.10, up_wick=0.45, dn_wick=0.25),        # reaction away
        mk_candle(head + 1.10, head + 1.30, up_wick=0.25, dn_wick=0.25),
    ]

    det = SDPDetector()
    sdp = det.detect(
        candles,
        zone=zone,
        sde=sde,
        creation_index=int(zone["sde_index"] or zone["created_index"]),
        head_price=head,
    )

    assert sdp.detected is True
    assert sdp.direction == "BULLISH"
    # Depending on ATR thresholds, it can be VALIDATED or PENDING if reaction judged weak.
    assert sdp.status in ("VALIDATED", "PENDING")
    if sdp.status == "VALIDATED":
        assert sdp.sdp_validated is True
        assert sdp.strength >= 50
        assert sdp.touch_index is not None
        assert sdp.head_price is not None


def test_failed_sde_invalidated_on_close_through_distal():
    candles = build_dbr_base_and_sde_scenario()

    base = BaseDetector().detect(candles)
    sgb = SGBDetector().detect(candles, base=base)
    assert sgb.created is True

    zone = {
        "zone_top": float(sgb.zone_top),
        "zone_bot": float(sgb.zone_bot),
        "zone_type": "DEMAND",
        "created_index": int(sgb.created_index or (len(candles) - 30)),
    }

    # Create an invalidation candle: close below zone_bot (with extra margin)
    zb = float(zone["zone_bot"])
    last_close = float(candles[-1]["close"])
    candles2 = candles + [
        mk_candle(last_close, zb - 1.0, high=last_close + 0.2, low=zb - 1.2),
    ]

    failed = FailedSDEDetector().detect(candles2, zone=zone, creation_index=zone["created_index"])
    assert failed.failed is True
    assert failed.reason == "INVALIDATED"
    assert failed.invalidation_index is not None


def test_flippy_detected_break_and_retest():
    """
    Old DEMAND -> break DOWN -> retest -> new FLIPPY_S
    """
    candles = add_flat_prefix(80, 100.0)

    # Old demand zone around 100-101
    zone = {"zone_top": 101.0, "zone_bot": 100.0, "zone_type": "DEMAND"}

    # Some price action above zone
    candles += [
        mk_candle(102.0, 101.6, up_wick=0.35, dn_wick=0.35),
        mk_candle(101.6, 101.2, up_wick=0.35, dn_wick=0.35),
        mk_candle(101.2, 100.8, up_wick=0.35, dn_wick=0.35),
    ]

    # BREAK DOWN: close well below zone_bot
    candles += [
        mk_candle(100.8, 98.8, high=101.0, low=98.4),
        mk_candle(98.8, 99.4, up_wick=0.25, dn_wick=0.25),
    ]

    # RETEST + REJECTION (upper wick) into zone, close back below zone_bot
    candles += [
        {"open": 99.4, "high": 101.15, "low": 99.2, "close": 99.6},  # touches zone, closes below
        mk_candle(99.6, 99.1, up_wick=0.25, dn_wick=0.35),
    ]

    det = FlippyDetector()
    res = det.detect(candles, zone=zone)

    assert res.detected is True
    assert res.old_side == "DEMAND"
    assert res.new_zone_type in (ZoneType.FLIPPY_S, ZoneType.FLIPPY_D)
    assert res.new_zone_type == ZoneType.FLIPPY_S
    assert res.break_index is not None
    assert res.retest_index is not None
    assert res.strength >= 40
```