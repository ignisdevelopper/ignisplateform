"""
core/sd_zones/sdp_detector.py — SDP (Successful Decision Point) detector (IGNIS / HLZ)

SDP = validation que le "HEAD" (niveau décisionnel) a été tenu.
Interprétation générique HLZ (robuste) :

- On dispose d’une zone S&D (SGB/SDE) et d’un HEAD level.
- DEMAND (bullish) :
    • Le prix touche le HEAD (proximité/tolérance)
    • Le HEAD est "tenu" si :
        - pas de clôture significative sous le HEAD (avec buffer)
        - réaction haussière suffisante après le touch (move away >= X*ATR)
- SUPPLY (bearish) :
    • touche HEAD
    • pas de close significative au-dessus du HEAD
    • réaction baissière suffisante

HEAD level :
- Priorité : head_price param → zone.head_price/sdp_head/head/dp_level → sde low/high → zone edge (fallback)

Ce module renvoie :
- status: "PENDING" | "VALIDATED" | "INVALIDATED"
- sdp_validated: bool
- head_price
- touch_index + validation_index
- strength 0..100

Design :
- Stateless
- Tolérant : candles dict/obj ; zone/sde dict/obj
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

from app import SCORING_THRESHOLDS

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers — tolérant dict/obj
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


def _o_get(o: Any, key: str, default: Any = None) -> Any:
    if o is None:
        return default
    if isinstance(o, dict):
        return o.get(key, default)
    return getattr(o, key, default)


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


def _normalize_bounds(top: float, bot: float) -> tuple[float, float]:
    top = float(top)
    bot = float(bot)
    return (top, bot) if top >= bot else (bot, top)


def _infer_side(zone: Any) -> tuple[str, str]:
    """
    Returns (side, direction):
      - side: "DEMAND"|"SUPPLY"
      - direction: "BULLISH"|"BEARISH"
    """
    zt = str(_o_get(zone, "zone_type", "") or _o_get(zone, "type", "") or _o_get(zone, "zoneType", "")).upper()
    if any(k in zt for k in ("DEMAND", "FLIPPY_D", "HIDDEN_D")):
        return "DEMAND", "BULLISH"
    if any(k in zt for k in ("SUPPLY", "FLIPPY_S", "HIDDEN_S")):
        return "SUPPLY", "BEARISH"
    # fallback: unknown -> treat as demand by default
    return "DEMAND", "BULLISH"


def _touches_level(candle: Any, level: float, tol: float) -> bool:
    hi = _c_get(candle, "high")
    lo = _c_get(candle, "low")
    return not (hi < (level - tol) or lo > (level + tol))


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class SDPConfig:
    lookback: int = 1200
    atr_period: int = 14

    # HEAD tolerance (proximité)
    head_tolerance_pct: float = float(SCORING_THRESHOLDS.get("SDP_HEAD_TOLERANCE", 0.002))  # 0.2%
    head_tolerance_atr_mult: float = 0.25
    use_atr_tolerance: bool = True

    # Invalidation (close through head)
    invalidation_buffer_atr_mult: float = 0.10
    invalidation_buffer_pct: float = 0.0010

    # Validation reaction
    reaction_window: int = 8
    min_reaction_atr_mult: float = 0.50

    # Confirmation window after touch
    confirm_window: int = 3
    require_close_back_in_favor: bool = True  # bullish: close > head ; bearish: close < head

    # Score weights
    w_hold: float = 0.45
    w_reaction: float = 0.35
    w_recency: float = 0.20


@dataclass
class SDPResult:
    detected: bool = False
    status: str = ""                      # "PENDING" | "VALIDATED" | "INVALIDATED"
    sdp_validated: bool = False

    side: str = ""                        # "DEMAND"|"SUPPLY"
    direction: str = ""                   # "BULLISH"|"BEARISH"

    head_price: Optional[float] = None
    head_tolerance: Optional[float] = None

    atr: Optional[float] = None
    creation_index: Optional[int] = None

    touch_index: Optional[int] = None
    validation_index: Optional[int] = None
    invalidation_index: Optional[int] = None

    reaction_move: Optional[float] = None
    reaction_move_atr: Optional[float] = None

    strength: int = 0                     # 0..100
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "detected": self.detected,
            "status": self.status,
            "sdp_validated": self.sdp_validated,
            "side": self.side,
            "direction": self.direction,
            "head_price": self.head_price,
            "head_tolerance": self.head_tolerance,
            "atr": self.atr,
            "creation_index": self.creation_index,
            "touch_index": self.touch_index,
            "validation_index": self.validation_index,
            "invalidation_index": self.invalidation_index,
            "reaction_move": self.reaction_move,
            "reaction_move_atr": self.reaction_move_atr,
            "strength": self.strength,
            "details": self.details,
        }


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class SDPDetector:
    """
    Détecteur SDP (HEAD held).

    Entrées :
      - candles
      - zone : zone S&D (zone_top/zone_bot/zone_type)
      - sde  : SDEResult ou dict (optionnel)
      - creation_index : index de création (optionnel) ; sinon zone.created_index/sde_index/base_end_index
      - head_price : override du head (optionnel)
    """

    def __init__(self, config: Optional[SDPConfig] = None) -> None:
        self.config = config or SDPConfig()

    def detect(
        self,
        candles: list[Any],
        *,
        zone: Any,
        sde: Optional[Any] = None,
        creation_index: Optional[int] = None,
        head_price: Optional[float] = None,
        current_price: Optional[float] = None,
    ) -> SDPResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 60):
            return SDPResult(detected=False, status="INVALID", details={"reason": "not_enough_candles"})

        if zone is None:
            return SDPResult(detected=False, status="INVALID", details={"reason": "zone_required"})

        # slice lookback
        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            atr = 0.0

        zone_top = _o_get(zone, "zone_top")
        zone_bot = _o_get(zone, "zone_bot")
        if zone_top is None or zone_bot is None:
            return SDPResult(detected=False, status="INVALID", atr=float(atr), details={"reason": "zone_missing_bounds"})

        zt, zb = _normalize_bounds(float(zone_top), float(zone_bot))
        side, direction = _infer_side(zone)

        # resolve creation index
        if creation_index is None:
            creation_index = (
                _o_get(zone, "created_index")
                or _o_get(zone, "sde_index")
                or _o_get(zone, "sgb_index")
                or _o_get(zone, "base_end_index")
                or (_o_get(sde, "sde_index") if sde is not None else None)
                or (_o_get(sde, "index") if sde is not None else None)
            )
        if creation_index is None:
            creation_index = max(0, len(candles) - 250)

        creation_index = int(max(0, min(len(candles) - 1, creation_index)))
        local_creation = int(max(0, min(len(c) - 1, creation_index - offset)))

        # resolve head
        head = head_price
        if head is None:
            head = (
                _o_get(zone, "head_price")
                or _o_get(zone, "sdp_head")
                or _o_get(zone, "head")
                or _o_get(zone, "dp_level")
            )
        if head is None and sde is not None:
            # fallback: from sde candle extreme
            if direction == "BULLISH":
                head = _o_get(sde, "sde_low") or _o_get(sde, "low")
            else:
                head = _o_get(sde, "sde_high") or _o_get(sde, "high")
        if head is None:
            # last resort: use zone edge (proximal)
            head = zt if direction == "BULLISH" else zb

        try:
            head = float(head)
        except Exception:
            return SDPResult(detected=False, status="INVALID", atr=float(atr), details={"reason": "head_not_numeric"})

        # tolerance
        tol_pct = cfg.head_tolerance_pct * head
        tol_atr = cfg.head_tolerance_atr_mult * atr if (cfg.use_atr_tolerance and atr > 0) else 0.0
        tol = max(tol_pct, tol_atr)

        # invalidation buffer
        inv_buf = (cfg.invalidation_buffer_atr_mult * atr) if atr > 0 else (cfg.invalidation_buffer_pct * head)
        invalidation_level = (head - inv_buf) if direction == "BULLISH" else (head + inv_buf)

        # current price (optional)
        price = float(current_price) if current_price is not None else _c_get(candles[-1], "close")

        # scan after creation for touch / invalidation
        scan_start = min(len(c) - 1, local_creation + 1)
        touch_i = None
        invalid_i = None

        for i in range(scan_start, len(c)):
            cl = _c_get(c[i], "close")

            # invalidation first (hard close through head)
            if direction == "BULLISH":
                if cl < invalidation_level:
                    invalid_i = i
                    break
            else:
                if cl > invalidation_level:
                    invalid_i = i
                    break

            # touch
            if touch_i is None and _touches_level(c[i], head, tol):
                touch_i = i
                # don't break: we still want to catch immediate invalidation after touch
                # but validation will be computed from this touch
                # (we can exit early if you want more perf)
                # continue scanning? not required; break is fine.
                break

        if invalid_i is not None:
            return SDPResult(
                detected=True,
                status="INVALIDATED",
                sdp_validated=False,
                side=side,
                direction=direction,
                head_price=float(head),
                head_tolerance=float(tol),
                atr=float(atr),
                creation_index=creation_index,
                invalidation_index=offset + invalid_i,
                strength=0,
                details={
                    "reason": "close_through_head",
                    "invalidation_level": float(invalidation_level),
                    "invalidation_close": float(_c_get(c[invalid_i], "close")),
                    "buffers": {"inv_buf": inv_buf, "tol": tol},
                },
            )

        if touch_i is None:
            # pending: head not yet touched
            # compute proximity score
            dist = abs(price - head)
            prox_score01 = 0.0
            if cfg.use_atr_tolerance and atr > 0:
                prox_score01 = _clip01(1.0 - dist / max(1e-12, cfg.head_tolerance_atr_mult * atr))
            else:
                prox_score01 = _clip01(1.0 - dist / max(1e-12, cfg.head_tolerance_pct * head))

            strength = int(round(100 * _clip01(0.6 * prox_score01)))

            return SDPResult(
                detected=True,
                status="PENDING",
                sdp_validated=False,
                side=side,
                direction=direction,
                head_price=float(head),
                head_tolerance=float(tol),
                atr=float(atr),
                creation_index=creation_index,
                strength=strength,
                details={
                    "reason": "head_not_touched_yet",
                    "price": price,
                    "distance": dist,
                    "proximity_score01": round(prox_score01, 3),
                    "invalidation_level": float(invalidation_level),
                },
            )

        # ── validate hold + reaction after touch ─────────────────────────────
        # confirm window: ensure no invalid closes in favor/against immediately after touch
        conf_start = touch_i
        conf_end = min(len(c) - 1, touch_i + max(1, cfg.confirm_window) - 1)

        hold_ok = True
        close_in_favor_ok = not cfg.require_close_back_in_favor  # if requirement disabled, ok by default

        for j in range(conf_start, conf_end + 1):
            cl = _c_get(c[j], "close")
            if direction == "BULLISH":
                if cl < invalidation_level:
                    hold_ok = False
                    invalid_i = j
                    break
                if cl > head:
                    close_in_favor_ok = True
            else:
                if cl > invalidation_level:
                    hold_ok = False
                    invalid_i = j
                    break
                if cl < head:
                    close_in_favor_ok = True

        if not hold_ok:
            return SDPResult(
                detected=True,
                status="INVALIDATED",
                sdp_validated=False,
                side=side,
                direction=direction,
                head_price=float(head),
                head_tolerance=float(tol),
                atr=float(atr),
                creation_index=creation_index,
                touch_index=offset + touch_i,
                invalidation_index=offset + invalid_i if invalid_i is not None else None,
                strength=0,
                details={
                    "reason": "invalidated_after_touch",
                    "invalidation_level": float(invalidation_level),
                },
            )

        if cfg.require_close_back_in_favor and not close_in_favor_ok:
            return SDPResult(
                detected=True,
                status="PENDING",
                sdp_validated=False,
                side=side,
                direction=direction,
                head_price=float(head),
                head_tolerance=float(tol),
                atr=float(atr),
                creation_index=creation_index,
                touch_index=offset + touch_i,
                strength=40,
                details={"reason": "touch_but_no_close_in_favor"},
            )

        # reaction measure
        rx_start = touch_i + 1
        rx_end = min(len(c) - 1, rx_start + max(1, cfg.reaction_window) - 1)
        reaction = 0.0

        if rx_start <= rx_end:
            win = c[rx_start : rx_end + 1]
            if direction == "BULLISH":
                max_high = max(_c_get(x, "high") for x in win)
                reaction = max(0.0, max_high - head)
            else:
                min_low = min(_c_get(x, "low") for x in win)
                reaction = max(0.0, head - min_low)

        rx_atr = (reaction / atr) if atr > 0 else None
        rx_ok = (reaction >= cfg.min_reaction_atr_mult * atr) if atr > 0 else (reaction > 0)

        # scores
        hold_score01 = 1.0
        reaction_score01 = _clip01((rx_atr or 0.0) / max(1e-12, cfg.min_reaction_atr_mult)) if atr > 0 else (0.6 if reaction > 0 else 0.0)
        recency_bars = (len(c) - 1) - touch_i
        recency_score01 = _clip01(1.0 - recency_bars / 120.0)

        total01 = (
            cfg.w_hold * hold_score01
            + cfg.w_reaction * reaction_score01
            + cfg.w_recency * recency_score01
        )
        strength = int(round(100 * _clip01(total01)))

        if not rx_ok:
            # hold ok but reaction weak => keep as PENDING (or weak validated, depending preference)
            return SDPResult(
                detected=True,
                status="PENDING",
                sdp_validated=False,
                side=side,
                direction=direction,
                head_price=float(head),
                head_tolerance=float(tol),
                atr=float(atr),
                creation_index=creation_index,
                touch_index=offset + touch_i,
                reaction_move=float(reaction),
                reaction_move_atr=float(round(rx_atr, 4)) if rx_atr is not None else None,
                strength=strength,
                details={
                    "reason": "hold_ok_but_reaction_weak",
                    "scores01": {
                        "hold": 1.0,
                        "reaction": round(reaction_score01, 3),
                        "recency": round(recency_score01, 3),
                        "total01": round(_clip01(total01), 3),
                    },
                    "min_reaction_atr_mult": cfg.min_reaction_atr_mult,
                },
            )

        # VALIDATED
        return SDPResult(
            detected=True,
            status="VALIDATED",
            sdp_validated=True,
            side=side,
            direction=direction,
            head_price=float(head),
            head_tolerance=float(tol),
            atr=float(atr),
            creation_index=creation_index,
            touch_index=offset + touch_i,
            validation_index=offset + rx_end if rx_end is not None else (offset + touch_i),
            reaction_move=float(reaction),
            reaction_move_atr=float(round(rx_atr, 4)) if rx_atr is not None else None,
            strength=strength,
            details={
                "scores01": {
                    "hold": 1.0,
                    "reaction": round(reaction_score01, 3),
                    "recency": round(recency_score01, 3),
                    "total01": round(_clip01(total01), 3),
                },
                "invalidation_level": float(invalidation_level),
                "reaction_window": cfg.reaction_window,
            },
        )
