"""
core/sd_zones/sde_detector.py — SDE detector (IGNIS / HLZ)

SDE (Significant Engulf) — validation d’une impulsion (engulf) qui "englobe" une base
et confirme une zone Supply/Demand exploitable.

Heuristique robuste (générique) :
- On part d'une BASE (idéalement fournie par base_engine.BaseDetector) :
    base_start_index, base_end_index, base_top, base_bot, base_type
- On cherche une bougie "engulf" juste après la base :
    • DEMAND / bullish SDE :
        - close au-dessus de base_top (+ buffer)
        - la bougie pénètre suffisamment la base via son low (engulf_ratio)
        - body/range + close strength OK
        - departure (distance close - base_top) >= X*ATR
    • SUPPLY / bearish SDE :
        - close en-dessous de base_bot (- buffer)
        - la bougie pénètre suffisamment la base via son high (engulf_ratio)
        - body/range + close strength OK
        - departure >= X*ATR

Design :
- Stateless
- Tolérant : candles dict/obj, base dict/obj
- Peut auto-détecter une base si base=None (optionnel)

Sortie :
- SDEResult(detected, direction, score, engulf_ratio, indices, reason, details)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

from app import BaseType, SCORING_THRESHOLDS

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers (candles / base) — tolérant dict/obj
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


def _b_get(b: Any, key: str, default: Any = None) -> Any:
    if b is None:
        return default
    if isinstance(b, dict):
        return b.get(key, default)
    return getattr(b, key, default)


def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _range(c: Any) -> float:
    return max(0.0, _c_get(c, "high") - _c_get(c, "low"))


def _body(c: Any) -> float:
    return abs(_c_get(c, "close") - _c_get(c, "open"))


def _close_strength(c: Any, direction: str) -> float:
    """
    0..1 close position in range.
    - bullish => close near high
    - bearish => close near low
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


def _departure_direction_from_base_type(base_type: str) -> Optional[str]:
    """
    BaseType -> direction de départ attendu.
    - RBR / DBR : bullish departure => demand context
    - DBD / RBD : bearish departure => supply context
    """
    bt = (base_type or "").upper()
    if bt in (BaseType.RBR, BaseType.DBR):
        return "BULLISH"
    if bt in (BaseType.DBD, BaseType.RBD):
        return "BEARISH"
    return None


def _engulf_ratio_for_sde(
    *,
    candle: Any,
    base_top: float,
    base_bot: float,
    direction: str,
) -> float:
    """
    Engulf ratio (0..1) = "profondeur" de pénétration de la bougie dans la base.
    - bullish : mesure via low (plus le low est bas dans la base, plus ratio est haut)
    - bearish : mesure via high (plus le high est haut dans la base, plus ratio est haut)
    """
    height = max(1e-12, base_top - base_bot)

    lo = _c_get(candle, "low")
    hi = _c_get(candle, "high")

    if direction == "BULLISH":
        # penetration from base_top down to low
        # low <= base_bot => 1.0
        depth = base_top - max(lo, base_bot)
    else:
        # penetration from base_bot up to high
        # high >= base_top => 1.0
        depth = min(hi, base_top) - base_bot

    return _clip01(depth / height)


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class SDEConfig:
    lookback: int = 260
    atr_period: int = 14

    # Base usage
    auto_detect_base_if_missing: bool = True

    # Scan for SDE candle after base
    max_bars_after_base: int = 6

    # Core thresholds
    engulf_ratio_min: float = float(SCORING_THRESHOLDS.get("ENGULFMENT_MIN", 0.85))
    close_buffer_atr_mult: float = 0.05  # close above/below edge + buffer*ATR
    min_departure_atr_mult: float = 0.60

    # Candle quality
    min_body_to_range: float = 0.15
    min_close_strength: float = 0.55

    # Allow wick-break if close-break not met (rare); keep strict by default
    allow_wick_break: bool = False

    # Scoring weights
    w_engulf: float = 0.40
    w_departure: float = 0.25
    w_close: float = 0.20
    w_candle_quality: float = 0.15


@dataclass
class SDEResult:
    detected: bool = False
    direction: str = ""               # "BULLISH" | "BEARISH"
    score: int = 0                    # 0..100

    base_type: Optional[str] = None
    base_start_index: Optional[int] = None
    base_end_index: Optional[int] = None
    base_top: Optional[float] = None
    base_bot: Optional[float] = None
    base_height: Optional[float] = None

    sde_index: Optional[int] = None
    sde_open: Optional[float] = None
    sde_high: Optional[float] = None
    sde_low: Optional[float] = None
    sde_close: Optional[float] = None

    engulf_ratio: Optional[float] = None
    departure: Optional[float] = None
    departure_atr: Optional[float] = None

    atr: Optional[float] = None
    reason: str = ""
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "detected": self.detected,
            "direction": self.direction,
            "score": self.score,
            "base_type": self.base_type,
            "base_start_index": self.base_start_index,
            "base_end_index": self.base_end_index,
            "base_top": self.base_top,
            "base_bot": self.base_bot,
            "base_height": self.base_height,
            "sde_index": self.sde_index,
            "sde_open": self.sde_open,
            "sde_high": self.sde_high,
            "sde_low": self.sde_low,
            "sde_close": self.sde_close,
            "engulf_ratio": self.engulf_ratio,
            "departure": self.departure,
            "departure_atr": self.departure_atr,
            "atr": self.atr,
            "reason": self.reason,
            "details": self.details,
        }


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class SDEDetector:
    """
    SDE detector.

    Usage :
        det = SDEDetector()
        res = det.detect(candles, base=base_result)
    """

    def __init__(self, config: Optional[SDEConfig] = None) -> None:
        self.config = config or SDEConfig()

    def detect(
        self,
        candles: list[Any],
        *,
        base: Optional[Any] = None,
        direction_hint: Optional[str] = None,
    ) -> SDEResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 40):
            return SDEResult(detected=False, reason="NOT_ENOUGH_CANDLES")

        # Focus lookback for ATR stability
        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            atr = 0.0

        # If base missing: auto detect
        if base is None and cfg.auto_detect_base_if_missing:
            try:
                from app.core.base_engine.base_detector import BaseDetector
                base = BaseDetector().detect(candles)
                if not getattr(base, "detected", False) and not (isinstance(base, dict) and base.get("detected")):
                    base = None
            except Exception as exc:
                log.warning("sde_base_autodetect_failed", error=str(exc))
                base = None

        if base is None:
            return SDEResult(detected=False, reason="BASE_REQUIRED", atr=float(atr))

        # Extract base fields
        base_type = _b_get(base, "base_type", "") or _b_get(base, "type", "")
        b_start = _b_get(base, "base_start_index")
        b_end = _b_get(base, "base_end_index")
        b_top = _b_get(base, "base_top")
        b_bot = _b_get(base, "base_bot")

        if b_start is None or b_end is None or b_top is None or b_bot is None:
            return SDEResult(detected=False, reason="BASE_MISSING_FIELDS", atr=float(atr))

        b_start = int(b_start)
        b_end = int(b_end)
        b_top = float(b_top)
        b_bot = float(b_bot)
        if b_top < b_bot:
            b_top, b_bot = b_bot, b_top

        if b_end >= len(candles) or b_start < 0 or b_end <= b_start:
            return SDEResult(
                detected=False,
                reason="BASE_INDICES_INVALID",
                atr=float(atr),
                details={"b_start": b_start, "b_end": b_end, "candles_len": len(candles)},
            )

        # Determine expected direction
        direction = None
        if direction_hint:
            dh = direction_hint.upper().strip()
            if dh in ("BULLISH", "BEARISH"):
                direction = dh

        if direction is None and base_type:
            direction = _departure_direction_from_base_type(str(base_type))

        if direction is None:
            # fallback: infer by immediate move after base (very rough)
            post_close = _c_get(candles[min(len(candles) - 1, b_end + 1)], "close") if (b_end + 1) < len(candles) else _c_get(candles[b_end], "close")
            base_mid = (b_top + b_bot) / 2
            direction = "BULLISH" if post_close >= base_mid else "BEARISH"

        # Scan for SDE candle after base end
        s_start = b_end + 1
        s_end = min(len(candles) - 1, b_end + cfg.max_bars_after_base)
        if s_start > s_end:
            return SDEResult(
                detected=False,
                reason="NO_ROOM_AFTER_BASE",
                base_type=str(base_type) if base_type else None,
                base_start_index=b_start,
                base_end_index=b_end,
                base_top=b_top,
                base_bot=b_bot,
                atr=float(atr),
            )

        close_buf = (cfg.close_buffer_atr_mult * atr) if atr > 0 else 0.0

        best: Optional[SDEResult] = None
        best_score = 0

        for i in range(s_start, s_end + 1):
            cd = candles[i]
            o = _c_get(cd, "open")
            h = _c_get(cd, "high")
            l = _c_get(cd, "low")
            cl = _c_get(cd, "close")

            # Candle direction filter
            if direction == "BULLISH" and cl <= o:
                continue
            if direction == "BEARISH" and cl >= o:
                continue

            rng = max(1e-12, h - l)
            body = abs(cl - o)

            if (body / rng) < cfg.min_body_to_range:
                continue

            cs = _close_strength(cd, direction)
            if cs < cfg.min_close_strength:
                continue

            # Break condition
            if direction == "BULLISH":
                broke = (cl >= (b_top + close_buf)) or (cfg.allow_wick_break and h >= (b_top + close_buf))
                if not broke:
                    continue
                departure = max(0.0, cl - b_top)
            else:
                broke = (cl <= (b_bot - close_buf)) or (cfg.allow_wick_break and l <= (b_bot - close_buf))
                if not broke:
                    continue
                departure = max(0.0, b_bot - cl)

            departure_atr = (departure / atr) if (atr and atr > 0) else None
            if atr > 0 and departure < cfg.min_departure_atr_mult * atr:
                continue

            # Engulf ratio into base
            er = _engulf_ratio_for_sde(
                candle=cd,
                base_top=b_top,
                base_bot=b_bot,
                direction=direction,
            )
            if er < cfg.engulf_ratio_min:
                continue

            # ── Scoring 0..1 ────────────────────────────────────────────────
            engulf_score01 = _clip01((er - cfg.engulf_ratio_min) / max(1e-12, (1.0 - cfg.engulf_ratio_min)))
            dep_score01 = 0.6
            if atr > 0:
                dep_score01 = _clip01(departure / max(1e-12, cfg.min_departure_atr_mult * atr))
            close_score01 = _clip01((cs - cfg.min_close_strength) / max(1e-12, (1.0 - cfg.min_close_strength)))
            candle_q01 = _clip01((body / rng - cfg.min_body_to_range) / max(1e-12, (1.0 - cfg.min_body_to_range)))

            total01 = (
                cfg.w_engulf * engulf_score01
                + cfg.w_departure * dep_score01
                + cfg.w_close * close_score01
                + cfg.w_candle_quality * candle_q01
            )
            score = int(round(100 * _clip01(total01)))

            if score >= best_score:
                best_score = score
                best = SDEResult(
                    detected=True,
                    direction=direction,
                    score=score,
                    base_type=str(base_type) if base_type else None,
                    base_start_index=b_start,
                    base_end_index=b_end,
                    base_top=float(b_top),
                    base_bot=float(b_bot),
                    base_height=float(b_top - b_bot),
                    sde_index=int(i),
                    sde_open=float(o),
                    sde_high=float(h),
                    sde_low=float(l),
                    sde_close=float(cl),
                    engulf_ratio=float(round(er, 4)),
                    departure=float(round(departure, 8)),
                    departure_atr=float(round(departure_atr, 4)) if departure_atr is not None else None,
                    atr=float(atr),
                    reason="OK",
                    details={
                        "scores01": {
                            "engulf": round(engulf_score01, 3),
                            "departure": round(dep_score01, 3),
                            "close": round(close_score01, 3),
                            "candle_quality": round(candle_q01, 3),
                            "total01": round(_clip01(total01), 3),
                        },
                        "filters": {
                            "engulf_ratio_min": cfg.engulf_ratio_min,
                            "min_departure_atr_mult": cfg.min_departure_atr_mult,
                            "min_close_strength": cfg.min_close_strength,
                            "min_body_to_range": cfg.min_body_to_range,
                            "close_buffer_atr_mult": cfg.close_buffer_atr_mult,
                        },
                        "computed": {
                            "close_strength": round(cs, 4),
                            "body_to_range": round(body / rng, 4),
                            "close_buffer": close_buf,
                        },
                    },
                )

        if best is None:
            return SDEResult(
                detected=False,
                direction=direction,
                base_type=str(base_type) if base_type else None,
                base_start_index=b_start,
                base_end_index=b_end,
                base_top=float(b_top),
                base_bot=float(b_bot),
                base_height=float(b_top - b_bot),
                atr=float(atr),
                reason="NO_SDE_FOUND",
                details={
                    "scan": {"start": s_start, "end": s_end},
                    "config": {
                        "engulf_ratio_min": cfg.engulf_ratio_min,
                        "max_bars_after_base": cfg.max_bars_after_base,
                        "min_departure_atr_mult": cfg.min_departure_atr_mult,
                    },
                },
            )

        return best
