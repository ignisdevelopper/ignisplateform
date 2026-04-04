"""
core/sd_zones/flippy_detector.py — FLIPPY zone detector (IGNIS / HLZ)

FLIPPY = zone de manipulation / flip S ↔ D :
- Ancienne DEMAND qui devient SUPPLY :
    1) Break DOWN : clôture sous zone_bot (avec buffer)
    2) Retest : retour dans/près de la zone puis rejet baissier (close sous zone_bot)
    => nouvelle zone = FLIPPY_S

- Ancienne SUPPLY qui devient DEMAND :
    1) Break UP : clôture au-dessus zone_top (avec buffer)
    2) Retest : retour dans/près de la zone puis rejet haussier (close au-dessus zone_top)
    => nouvelle zone = FLIPPY_D

Objectif :
- Détecter proprement ce flip pour invalider certains setups (comme tu l’as écrit dans alert_engine)
- Fournir indices break/retest + score (0..100) pour pipeline/scoring.

Design :
- Stateless
- Tolérant : candles dict/obj (open/high/low/close)
- zone dict/obj (zone_top, zone_bot, zone_type)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

from app import ZoneType

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers (tolérant)
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


def _z_get(z: Any, key: str, default: Any = None) -> Any:
    if z is None:
        return default
    if isinstance(z, dict):
        return z.get(key, default)
    return getattr(z, key, default)


def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _range(c: Any) -> float:
    return max(0.0, _c_get(c, "high") - _c_get(c, "low"))


def _body(c: Any) -> float:
    return abs(_c_get(c, "close") - _c_get(c, "open"))


def _upper_wick(c: Any) -> float:
    o = _c_get(c, "open")
    cl = _c_get(c, "close")
    h = _c_get(c, "high")
    return max(0.0, h - max(o, cl))


def _lower_wick(c: Any) -> float:
    o = _c_get(c, "open")
    cl = _c_get(c, "close")
    l = _c_get(c, "low")
    return max(0.0, min(o, cl) - l)


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


def _normalize_bounds(top: float, bot: float) -> tuple[float, float]:
    top = float(top)
    bot = float(bot)
    return (top, bot) if top >= bot else (bot, top)


def _infer_original_side(zone_type: str) -> tuple[Optional[str], Optional[str]]:
    """
    Returns:
      old_side in {"DEMAND","SUPPLY"} or None
      new_flippy_type in {"FLIPPY_D","FLIPPY_S"} or None (opposite)
    """
    z = (zone_type or "").upper()

    if "DEMAND" in z or "HIDDEN_D" in z or "FLIPPY_D" in z:
        # assume originally demand
        return "DEMAND", ZoneType.FLIPPY_S
    if "SUPPLY" in z or "HIDDEN_S" in z or "FLIPPY_S" in z:
        return "SUPPLY", ZoneType.FLIPPY_D

    return None, None


def _intersects(high: float, low: float, top: float, bot: float) -> bool:
    return not (high < bot or low > top)


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class FlippyConfig:
    lookback: int = 500
    atr_period: int = 14

    # Break validation
    require_close_break: bool = True
    break_buffer_atr_mult: float = 0.10       # close beyond distal by X*ATR
    break_min_extension_atr_mult: float = 0.15  # extension minimal (beyond edge), en ATR

    # Retest validation
    retest_window_bars: int = 120
    retest_tolerance_atr_mult: float = 0.25   # "touch" distance around edge
    retest_close_buffer_atr_mult: float = 0.05  # close must be on new side with buffer

    # Rejection quality on retest candle
    require_rejection: bool = True
    min_wick_to_body: float = 1.0
    min_wick_to_range: float = 0.35
    min_body_to_range: float = 0.10

    # Scoring weights
    w_break: float = 0.45
    w_retest: float = 0.40
    w_speed: float = 0.15


@dataclass
class FlippyResult:
    detected: bool = False
    old_side: str = ""                 # "DEMAND" | "SUPPLY"
    new_zone_type: Optional[str] = None  # ZoneType.FLIPPY_D | ZoneType.FLIPPY_S

    strength: int = 0                  # 0..100

    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None
    zone_type: Optional[str] = None

    atr: Optional[float] = None

    break_index: Optional[int] = None
    break_close: Optional[float] = None
    break_distance: Optional[float] = None
    retest_index: Optional[int] = None
    retest_close: Optional[float] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class FlippyDetector:
    """
    Détecteur FLIPPY.

    API:
        det = FlippyDetector()
        res = det.detect(candles, zone=zone)

    zone attendu :
        {zone_top, zone_bot, zone_type}

    Option :
        old_side_hint="DEMAND"|"SUPPLY" si zone_type non fiable.
    """

    def __init__(self, config: Optional[FlippyConfig] = None) -> None:
        self.config = config or FlippyConfig()

    def detect(
        self,
        candles: list[Any],
        *,
        zone: Any,
        old_side_hint: Optional[str] = None,
    ) -> FlippyResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 80):
            return FlippyResult(detected=False, details={"reason": "not_enough_candles"})

        if zone is None:
            return FlippyResult(detected=False, details={"reason": "zone_required"})

        zone_top = _z_get(zone, "zone_top")
        zone_bot = _z_get(zone, "zone_bot")
        zone_type = str(_z_get(zone, "zone_type", "") or _z_get(zone, "type", "") or _z_get(zone, "zoneType", ""))

        if zone_top is None or zone_bot is None:
            return FlippyResult(detected=False, zone_type=zone_type or None, details={"reason": "zone_missing_bounds"})

        zt, zb = _normalize_bounds(float(zone_top), float(zone_bot))

        # infer old side
        old_side, new_flippy_type = _infer_original_side(zone_type)
        if old_side_hint:
            osh = old_side_hint.upper().strip()
            if osh in ("DEMAND", "SUPPLY"):
                old_side = osh
                new_flippy_type = ZoneType.FLIPPY_S if osh == "DEMAND" else ZoneType.FLIPPY_D

        if old_side is None or new_flippy_type is None:
            return FlippyResult(
                detected=False,
                zone_type=zone_type or None,
                zone_top=zt,
                zone_bot=zb,
                details={"reason": "cannot_infer_old_side", "zone_type": zone_type},
            )

        # focus lookback (most recent part)
        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            atr = 0.0

        # buffers
        break_buf = cfg.break_buffer_atr_mult * atr if atr > 0 else 0.0
        break_min_ext = cfg.break_min_extension_atr_mult * atr if atr > 0 else 0.0
        retest_tol = cfg.retest_tolerance_atr_mult * atr if atr > 0 else 0.0
        retest_close_buf = cfg.retest_close_buffer_atr_mult * atr if atr > 0 else 0.0

        # ── 1) Find break ───────────────────────────────────────────────────
        break_i = None
        break_close = None
        break_dist = None
        break_meta: dict[str, Any] = {}

        # For old DEMAND => break DOWN under zone_bot
        # For old SUPPLY => break UP above zone_top
        for i in range(len(c) - 1, -1, -1):
            cc = c[i]
            cl = _c_get(cc, "close")
            hi = _c_get(cc, "high")
            lo = _c_get(cc, "low")

            if old_side == "DEMAND":
                # broke below distal (zone_bot)
                broke = (cl <= (zb - break_buf)) if cfg.require_close_break else (lo <= (zb - break_buf))
                if not broke:
                    continue
                # extension
                ext = (zb - cl) if cfg.require_close_break else (zb - lo)
                if ext < break_min_ext:
                    continue

                break_i = i
                break_close = cl
                break_dist = abs(cl - zb)
                break_meta = {"direction": "DOWN", "extension": ext, "break_edge": "zone_bot"}
                break

            else:  # SUPPLY
                broke = (cl >= (zt + break_buf)) if cfg.require_close_break else (hi >= (zt + break_buf))
                if not broke:
                    continue
                ext = (cl - zt) if cfg.require_close_break else (hi - zt)
                if ext < break_min_ext:
                    continue

                break_i = i
                break_close = cl
                break_dist = abs(cl - zt)
                break_meta = {"direction": "UP", "extension": ext, "break_edge": "zone_top"}
                break

        if break_i is None:
            return FlippyResult(
                detected=False,
                old_side=old_side,
                new_zone_type=None,
                zone_type=zone_type or None,
                zone_top=zt,
                zone_bot=zb,
                atr=float(atr),
                details={"reason": "no_break_found"},
            )

        # ── 2) Find retest after break ──────────────────────────────────────
        # Search forward from break_i to break_i + retest_window_bars
        retest_i = None
        retest_close = None
        retest_meta: dict[str, Any] = {}

        start = break_i + 1
        end = min(len(c) - 1, break_i + cfg.retest_window_bars)

        for j in range(start, end + 1):
            cj = c[j]
            o = _c_get(cj, "open")
            cl = _c_get(cj, "close")
            hi = _c_get(cj, "high")
            lo = _c_get(cj, "low")
            rng = max(1e-12, hi - lo)
            bdy = abs(cl - o)

            if bdy / rng < cfg.min_body_to_range:
                continue

            if old_side == "DEMAND":
                # new should be SUPPLY => retest from below toward zone_bot/zone range, then reject down
                touched = _intersects(hi, lo, top=zt + retest_tol, bot=zb - retest_tol)
                if not touched:
                    continue

                # must close back below zone_bot (new side) with buffer
                if cl > (zb - retest_close_buf):
                    continue

                # rejection quality (upper wick)
                if cfg.require_rejection:
                    wick = _upper_wick(cj)
                    wick_to_body = wick / max(1e-12, bdy)
                    wick_to_range = wick / rng
                    if wick_to_body < cfg.min_wick_to_body:
                        continue
                    if wick_to_range < cfg.min_wick_to_range:
                        continue

                    rej_score01 = _clip01(
                        0.5 * (wick_to_body / max(1e-12, cfg.min_wick_to_body) - 1.0) +
                        0.5 * (wick_to_range / max(1e-12, cfg.min_wick_to_range) - 1.0)
                    )
                else:
                    rej_score01 = 0.65

                retest_i = j
                retest_close = cl
                retest_meta = {
                    "touched": True,
                    "close_ok": True,
                    "rejection_score01": round(rej_score01, 3),
                    "wick_upper": round(_upper_wick(cj), 8),
                }
                break

            else:
                # old SUPPLY -> new DEMAND : retest from above then reject up
                touched = _intersects(hi, lo, top=zt + retest_tol, bot=zb - retest_tol)
                if not touched:
                    continue

                if cl < (zt + retest_close_buf):
                    continue

                if cfg.require_rejection:
                    wick = _lower_wick(cj)
                    wick_to_body = wick / max(1e-12, bdy)
                    wick_to_range = wick / rng
                    if wick_to_body < cfg.min_wick_to_body:
                        continue
                    if wick_to_range < cfg.min_wick_to_range:
                        continue

                    rej_score01 = _clip01(
                        0.5 * (wick_to_body / max(1e-12, cfg.min_wick_to_body) - 1.0) +
                        0.5 * (wick_to_range / max(1e-12, cfg.min_wick_to_range) - 1.0)
                    )
                else:
                    rej_score01 = 0.65

                retest_i = j
                retest_close = cl
                retest_meta = {
                    "touched": True,
                    "close_ok": True,
                    "rejection_score01": round(rej_score01, 3),
                    "wick_lower": round(_lower_wick(cj), 8),
                }
                break

        if retest_i is None:
            return FlippyResult(
                detected=False,
                old_side=old_side,
                new_zone_type=None,
                zone_type=zone_type or None,
                zone_top=zt,
                zone_bot=zb,
                atr=float(atr),
                break_index=offset + break_i,
                break_close=float(break_close) if break_close is not None else None,
                break_distance=float(break_dist) if break_dist is not None else None,
                details={"reason": "break_found_but_no_retest", "break": break_meta},
            )

        # ── 3) Score ─────────────────────────────────────────────────────────
        # break score: extension vs threshold
        ext = float(break_meta.get("extension", 0.0))
        break_score01 = _clip01(ext / max(1e-12, break_min_ext) - 1.0) if break_min_ext > 0 else 0.7

        # retest score: rejection_score01 (already 0..1)
        retest_score01 = float(retest_meta.get("rejection_score01", 0.6))

        # speed score: faster retest => stronger (in HLZ, flippy retest rapide est plus "propre")
        bars = max(1, retest_i - break_i)
        speed_score01 = _clip01(1.0 - (bars - 1) / max(1, cfg.retest_window_bars))

        total01 = (
            cfg.w_break * break_score01
            + cfg.w_retest * retest_score01
            + cfg.w_speed * speed_score01
        )
        strength = int(round(100 * _clip01(total01)))

        return FlippyResult(
            detected=True,
            old_side=old_side,
            new_zone_type=str(new_flippy_type),
            strength=strength,
            zone_type=zone_type or None,
            zone_top=float(zt),
            zone_bot=float(zb),
            atr=float(atr),
            break_index=offset + break_i,
            break_close=float(break_close) if break_close is not None else None,
            break_distance=float(break_dist) if break_dist is not None else None,
            retest_index=offset + retest_i,
            retest_close=float(retest_close) if retest_close is not None else None,
            details={
                "scores01": {
                    "break": round(break_score01, 3),
                    "retest": round(retest_score01, 3),
                    "speed": round(speed_score01, 3),
                    "total01": round(_clip01(total01), 3),
                },
                "break": break_meta,
                "retest": retest_meta,
                "config": {
                    "require_close_break": cfg.require_close_break,
                    "require_rejection": cfg.require_rejection,
                },
            },
        )