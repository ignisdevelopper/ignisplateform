"""
core/decision_point/pe_detector.py — Pullback Entry (PE) detector (HLZ)

PE (Pullback Entry) :
- Après une impulsion "away" depuis une zone / DP, on attend un pullback vers :
  • la zone SGB (base / supply-demand)
  • ou un DP level (SDP / SB_LEVEL / KEY_LEVEL / TREND_LINE)
- Puis une confirmation (rejection / engulf / close strength) déclenche un signal d'entrée.

Ce module est :
- Stateless
- Tolérant aux candles dict/obj (open/high/low/close)
- Tolérant aux zone/dp dict/obj
- Utilisable en "signal now" (dernière bougie) ou "forming" (proximité)

Entrées typiques :
- candles: list[CandleLike]
- zone: dict|obj optionnel (zone_top, zone_bot, zone_type)
- dp:   dict|obj optionnel (level, dp_type, direction)
- current_price: float optionnel (sinon close dernière bougie)

Sortie :
- PullbackEntryResult : detected + state + direction + entry/invalid + meta
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

from app import DPType, ZoneType

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers (candles / dp / zone) — tolérant dict/obj
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


def _pct_distance(price: float, level: float) -> float:
    if level == 0:
        return 999.0
    return abs(price - level) / abs(level)


def _intersects(high: float, low: float, top: float, bot: float) -> bool:
    return not (high < bot or low > top)


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class PullbackEntryConfig:
    lookback: int = 220
    atr_period: int = 14

    # Proximity : "price approaching entry area"
    proximity_pct: float = 0.0025          # 0.25%
    proximity_atr_mult: float = 0.35
    use_atr_proximity: bool = True

    # Entry area definition
    dp_level_buffer_atr_mult: float = 0.20     # si on n'a pas de zone, un DP devient un mini-range ±buffer*ATR
    zone_entry_prefer_mid: bool = False       # sinon utiliser bot/top selon direction
    entry_buffer_atr_mult: float = 0.05       # buffer supplémentaire pour "touch"

    # Impulse-away validation (avant d'autoriser un PE)
    require_departure: bool = True
    departure_lookback: int = 30
    min_departure_atr_mult: float = 1.0

    # Confirmation candle (déclenchement)
    require_confirmation: bool = True
    min_wick_to_body: float = 1.2
    min_wick_to_range: float = 0.40
    min_body_to_range: float = 0.15
    min_close_strength: float = 0.55          # bullish close near high, bearish close near low

    # Engulf confirmation (option)
    allow_engulf_confirmation: bool = True

    # Invalidation
    invalidation_buffer_atr_mult: float = 0.05

    # Scoring weights
    w_proximity: float = 0.35
    w_departure: float = 0.25
    w_confirmation: float = 0.35
    w_context: float = 0.05


@dataclass
class PullbackEntryResult:
    detected: bool = False
    state: str = ""                 # "READY" | "APPROACHING" | "WAITING_CONFIRMATION" | "INVALID" | "NO_SIGNAL"
    direction: str = ""             # "BULLISH" | "BEARISH"

    strength: int = 0               # 0..100

    entry: Optional[float] = None
    entry_area_top: Optional[float] = None
    entry_area_bot: Optional[float] = None
    invalidation_level: Optional[float] = None

    dp_type: Optional[str] = None
    dp_level: Optional[float] = None

    zone_type: Optional[str] = None
    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None

    price: Optional[float] = None
    distance_pct: Optional[float] = None
    distance_atr: Optional[float] = None

    trigger_index: Optional[int] = None   # index bougie de confirmation (souvent dernière)
    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class PullbackEntryDetector:
    """
    Détecteur PE.

    Convention :
    - Si zone_type=DEMAND => direction bullish
    - Si zone_type=SUPPLY => direction bearish
    - Sinon on lit dp.direction si dispo
    """

    def __init__(self, config: Optional[PullbackEntryConfig] = None) -> None:
        self.config = config or PullbackEntryConfig()

    def detect(
        self,
        candles: list[Any],
        *,
        zone: Optional[Any] = None,
        dp: Optional[Any] = None,
        current_price: Optional[float] = None,
        direction_hint: Optional[str] = None,
    ) -> PullbackEntryResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 40):
            return PullbackEntryResult(detected=False, state="NO_SIGNAL", details={"reason": "not_enough_candles"})

        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            atr = 0.0

        price = float(current_price) if current_price is not None else _c_get(candles[-1], "close")

        # ── Infer direction ──────────────────────────────────────────────────
        direction = ""
        zt = str(_o_get(zone, "zone_type", "") or _o_get(zone, "type", "") or _o_get(zone, "zoneType", "")).upper()
        if zt:
            if any(k in zt for k in ("DEMAND", ZoneType.DEMAND, ZoneType.FLIPPY_D, ZoneType.HIDDEN_D)):
                direction = "BULLISH"
            elif any(k in zt for k in ("SUPPLY", ZoneType.SUPPLY, ZoneType.FLIPPY_S, ZoneType.HIDDEN_S)):
                direction = "BEARISH"

        if not direction and dp is not None:
            d = str(_o_get(dp, "direction", "") or "").upper()
            if d in ("BULLISH", "UP"):
                direction = "BULLISH"
            elif d in ("BEARISH", "DOWN"):
                direction = "BEARISH"

        if not direction and direction_hint:
            dh = direction_hint.upper().strip()
            if dh in ("BULLISH", "BEARISH"):
                direction = dh

        if not direction:
            return PullbackEntryResult(detected=False, state="NO_SIGNAL", details={"reason": "direction_unknown"})

        # ── Entry area (zone preferred, else dp mini-range) ──────────────────
        zone_top = _o_get(zone, "zone_top")
        zone_bot = _o_get(zone, "zone_bot")
        zone_top_f = float(zone_top) if zone_top is not None else None
        zone_bot_f = float(zone_bot) if zone_bot is not None else None
        if zone_top_f is not None and zone_bot_f is not None and zone_top_f < zone_bot_f:
            zone_top_f, zone_bot_f = zone_bot_f, zone_top_f

        dp_level = _o_get(dp, "level", None) or _o_get(dp, "dp_level", None)
        dp_type = _o_get(dp, "dp_type", None) or _o_get(dp, "type", None)
        try:
            dp_level_f = float(dp_level) if dp_level is not None else None
        except Exception:
            dp_level_f = None

        entry_top: Optional[float] = None
        entry_bot: Optional[float] = None

        if zone_top_f is not None and zone_bot_f is not None:
            entry_top, entry_bot = zone_top_f, zone_bot_f
        elif dp_level_f is not None and dp_level_f > 0 and atr > 0:
            buf = cfg.dp_level_buffer_atr_mult * atr
            entry_top = dp_level_f + buf
            entry_bot = dp_level_f - buf

        if entry_top is None or entry_bot is None:
            return PullbackEntryResult(
                detected=False,
                state="NO_SIGNAL",
                direction=direction,
                details={"reason": "no_entry_area", "zone_present": zone is not None, "dp_present": dp is not None},
            )

        if entry_top < entry_bot:
            entry_top, entry_bot = entry_bot, entry_top

        # Entry price suggestion
        if cfg.zone_entry_prefer_mid:
            entry_price = (entry_top + entry_bot) / 2
        else:
            entry_price = entry_bot if direction == "BULLISH" else entry_top

        # Invalidation (simple) : opposite side + buffer
        inv_buf = cfg.invalidation_buffer_atr_mult * atr if atr > 0 else 0.0
        invalidation = (entry_bot - inv_buf) if direction == "BULLISH" else (entry_top + inv_buf)

        # ── Proximity to entry area ──────────────────────────────────────────
        # distance to the "closest point" on the area
        if price > entry_top:
            dist = price - entry_top
        elif price < entry_bot:
            dist = entry_bot - price
        else:
            dist = 0.0

        dist_pct = _pct_distance(price, entry_price)
        dist_atr = (dist / atr) if (atr and atr > 0) else None

        near_by_pct = dist_pct <= cfg.proximity_pct
        near_by_atr = (dist <= cfg.proximity_atr_mult * atr) if (cfg.use_atr_proximity and atr and atr > 0) else False
        is_near = bool(near_by_pct or near_by_atr or dist == 0.0)

        # ── Require departure away (optional) ────────────────────────────────
        departure_score01 = 0.5
        departure_ok = True
        departure_meta: dict[str, Any] = {"enabled": cfg.require_departure}

        if cfg.require_departure and atr > 0:
            departure_ok, departure_score01, departure_meta = _check_departure_away(
                candles=c,
                entry_top=entry_top,
                entry_bot=entry_bot,
                direction=direction,
                atr=atr,
                lookback=cfg.departure_lookback,
                min_departure_atr_mult=cfg.min_departure_atr_mult,
            )

        # ── Confirmation candle (last candle by default) ─────────────────────
        confirmation_ok = True
        confirmation_score01 = 0.5
        conf_meta: dict[str, Any] = {"enabled": cfg.require_confirmation}

        last_idx = len(c) - 1
        last = c[last_idx]
        prev = c[last_idx - 1] if last_idx - 1 >= 0 else None

        # "touch" definition with small buffer
        touch_buf = (cfg.entry_buffer_atr_mult * atr) if (atr and atr > 0) else 0.0
        touched = _intersects(
            high=_c_get(last, "high"),
            low=_c_get(last, "low"),
            top=entry_top + touch_buf,
            bot=entry_bot - touch_buf,
        )

        if cfg.require_confirmation:
            confirmation_ok, confirmation_score01, conf_meta = _check_confirmation(
                candle=last,
                prev=prev,
                direction=direction,
                entry_top=entry_top,
                entry_bot=entry_bot,
                atr=atr,
                cfg=cfg,
                touched=touched,
            )

        # ── Determine state ──────────────────────────────────────────────────
        if direction == "BULLISH" and price < invalidation:
            return PullbackEntryResult(
                detected=False,
                state="INVALID",
                direction=direction,
                entry=entry_price,
                entry_area_top=entry_top,
                entry_area_bot=entry_bot,
                invalidation_level=invalidation,
                dp_type=str(dp_type) if dp_type else None,
                dp_level=dp_level_f,
                zone_type=zt if zt else None,
                zone_top=zone_top_f,
                zone_bot=zone_bot_f,
                price=price,
                distance_pct=round(dist_pct * 100, 4),
                distance_atr=round(dist_atr, 4) if dist_atr is not None else None,
                details={"reason": "price_below_invalidation"},
            )
        if direction == "BEARISH" and price > invalidation:
            return PullbackEntryResult(
                detected=False,
                state="INVALID",
                direction=direction,
                entry=entry_price,
                entry_area_top=entry_top,
                entry_area_bot=entry_bot,
                invalidation_level=invalidation,
                dp_type=str(dp_type) if dp_type else None,
                dp_level=dp_level_f,
                zone_type=zt if zt else None,
                zone_top=zone_top_f,
                zone_bot=zone_bot_f,
                price=price,
                distance_pct=round(dist_pct * 100, 4),
                distance_atr=round(dist_atr, 4) if dist_atr is not None else None,
                details={"reason": "price_above_invalidation"},
            )

        if not departure_ok:
            # We don't want PE if there's no clean departure away from the area
            state = "NO_SIGNAL" if not is_near else "APPROACHING"
            return PullbackEntryResult(
                detected=False,
                state=state,
                direction=direction,
                entry=entry_price,
                entry_area_top=entry_top,
                entry_area_bot=entry_bot,
                invalidation_level=invalidation,
                dp_type=str(dp_type) if dp_type else None,
                dp_level=dp_level_f,
                zone_type=zt if zt else None,
                zone_top=zone_top_f,
                zone_bot=zone_bot_f,
                price=price,
                distance_pct=round(dist_pct * 100, 4),
                distance_atr=round(dist_atr, 4) if dist_atr is not None else None,
                details={"departure": departure_meta, "reason": "departure_not_ok"},
            )

        if not is_near:
            return PullbackEntryResult(
                detected=False,
                state="NO_SIGNAL",
                direction=direction,
                entry=entry_price,
                entry_area_top=entry_top,
                entry_area_bot=entry_bot,
                invalidation_level=invalidation,
                dp_type=str(dp_type) if dp_type else None,
                dp_level=dp_level_f,
                zone_type=zt if zt else None,
                zone_top=zone_top_f,
                zone_bot=zone_bot_f,
                price=price,
                distance_pct=round(dist_pct * 100, 4),
                distance_atr=round(dist_atr, 4) if dist_atr is not None else None,
                details={"reason": "not_in_proximity", "departure": departure_meta},
            )

        # We are near/inside entry area
        if cfg.require_confirmation and not confirmation_ok:
            return PullbackEntryResult(
                detected=False,
                state="WAITING_CONFIRMATION",
                direction=direction,
                strength=int(round(100 * _clip01(
                    cfg.w_proximity * 0.8 + cfg.w_departure * departure_score01 + cfg.w_confirmation * confirmation_score01
                ))),
                entry=entry_price,
                entry_area_top=entry_top,
                entry_area_bot=entry_bot,
                invalidation_level=invalidation,
                dp_type=str(dp_type) if dp_type else None,
                dp_level=dp_level_f,
                zone_type=zt if zt else None,
                zone_top=zone_top_f,
                zone_bot=zone_bot_f,
                price=price,
                distance_pct=round(dist_pct * 100, 4),
                distance_atr=round(dist_atr, 4) if dist_atr is not None else None,
                trigger_index=None,
                details={
                    "reason": "near_but_no_confirmation",
                    "departure": departure_meta,
                    "confirmation": conf_meta,
                    "touched": touched,
                },
            )

        # READY (signal)
        # scoring
        proximity_score01 = _proximity_score01(price, entry_top, entry_bot, atr, cfg)
        score01 = (
            cfg.w_proximity * proximity_score01
            + cfg.w_departure * departure_score01
            + cfg.w_confirmation * confirmation_score01
            + cfg.w_context * 0.5
        )
        strength = int(round(100 * _clip01(score01)))

        return PullbackEntryResult(
            detected=True,
            state="READY",
            direction=direction,
            strength=strength,
            entry=entry_price,
            entry_area_top=entry_top,
            entry_area_bot=entry_bot,
            invalidation_level=invalidation,
            dp_type=str(dp_type) if dp_type else None,
            dp_level=dp_level_f,
            zone_type=zt if zt else None,
            zone_top=zone_top_f,
            zone_bot=zone_bot_f,
            price=price,
            distance_pct=round(dist_pct * 100, 4),
            distance_atr=round(dist_atr, 4) if dist_atr is not None else None,
            trigger_index=offset + last_idx,
            details={
                "departure": departure_meta,
                "confirmation": conf_meta,
                "scores": {
                    "proximity": round(proximity_score01, 3),
                    "departure": round(departure_score01, 3),
                    "confirmation": round(confirmation_score01, 3),
                    "total01": round(_clip01(score01), 3),
                },
                "touched": touched,
                "atr": atr,
            },
        )


# ═════════════════════════════════════════════════════════════════════════════=
# Internals — scoring / rules
# ═════════════════════════════════════════════════════════════════════════════=

def _proximity_score01(price: float, top: float, bot: float, atr: float, cfg: PullbackEntryConfig) -> float:
    # distance to area
    if price > top:
        dist = price - top
    elif price < bot:
        dist = bot - price
    else:
        dist = 0.0

    if cfg.use_atr_proximity and atr and atr > 0:
        denom = max(1e-12, cfg.proximity_atr_mult * atr)
        return _clip01(1.0 - dist / denom)

    # pct version around mid
    mid = (top + bot) / 2
    denom = max(1e-12, cfg.proximity_pct)
    return _clip01(1.0 - (_pct_distance(price, mid) / denom))


def _check_departure_away(
    *,
    candles: list[Any],
    entry_top: float,
    entry_bot: float,
    direction: str,
    atr: float,
    lookback: int,
    min_departure_atr_mult: float,
) -> tuple[bool, float, dict[str, Any]]:
    """
    Vérifie qu'il y a eu un move AWAY de l'entry area récemment.
    Heuristique :
      - On cherche un point de "dernier contact" avec l'area, puis un déplacement net >= X*ATR.
    """
    n = len(candles)
    if n < 20 or atr <= 0:
        return True, 0.5, {"enabled": True, "reason": "atr_or_data_small"}

    start = max(0, n - 1 - lookback)
    win = candles[start:]

    # last touch index within lookback
    last_touch = None
    for i in range(len(win) - 1, -1, -1):
        hi = _c_get(win[i], "high")
        lo = _c_get(win[i], "low")
        if _intersects(hi, lo, entry_top, entry_bot):
            last_touch = start + i
            break

    if last_touch is None:
        # no recent touch => departure not measurable, but we allow
        return True, 0.6, {"enabled": True, "last_touch": None, "reason": "no_touch_in_lookback"}

    after = candles[last_touch + 1 :]
    if len(after) < 2:
        return False, 0.0, {"enabled": True, "reason": "no_bars_after_touch", "last_touch": last_touch}

    if direction == "BULLISH":
        # away = up, measure max high above entry_top
        max_high = max(_c_get(x, "high") for x in after)
        net = max(0.0, max_high - entry_top)
    else:
        min_low = min(_c_get(x, "low") for x in after)
        net = max(0.0, entry_bot - min_low)

    min_req = min_departure_atr_mult * atr
    ok = net >= min_req
    score01 = _clip01(net / max(1e-9, min_req))  # >=1 => 1

    return ok, score01, {
        "enabled": True,
        "last_touch": last_touch,
        "net_move": net,
        "net_move_atr": round(net / atr, 3),
        "min_required": min_req,
        "ok": ok,
    }


def _close_strength(c: Any, direction: str) -> float:
    """
    0..1 : position du close dans le range.
    - bullish => close proche du high
    - bearish => close proche du low
    """
    h = _c_get(c, "high")
    l = _c_get(c, "low")
    cl = _c_get(c, "close")
    rng = max(1e-12, h - l)
    if direction == "BULLISH":
        return _clip01((cl - l) / rng)
    return _clip01((h - cl) / rng)


def _is_engulf(prev: Any, cur: Any, direction: str) -> bool:
    if prev is None:
        return False
    po = _c_get(prev, "open")
    pc = _c_get(prev, "close")
    co = _c_get(cur, "open")
    cc = _c_get(cur, "close")
    # simple body engulf
    if direction == "BULLISH":
        return (cc > co) and (cc >= po) and (co <= pc)
    return (cc < co) and (cc <= po) and (co >= pc)


def _check_confirmation(
    *,
    candle: Any,
    prev: Optional[Any],
    direction: str,
    entry_top: float,
    entry_bot: float,
    atr: float,
    cfg: PullbackEntryConfig,
    touched: bool,
) -> tuple[bool, float, dict[str, Any]]:
    """
    Confirmation sur la bougie courante :
    - doit toucher/être dans l'area (ou très proche)
    - rejet (wick dominant) + close strength
    OU engulf (option)
    """
    if not touched:
        return False, 0.0, {"reason": "not_touched"}

    o = _c_get(candle, "open")
    h = _c_get(candle, "high")
    l = _c_get(candle, "low")
    cl = _c_get(candle, "close")
    rng = max(1e-12, h - l)
    body = abs(cl - o)

    if body / rng < cfg.min_body_to_range:
        return False, 0.0, {"reason": "doji_body_too_small", "body_to_range": body / rng}

    wick = _lower_wick(candle) if direction == "BULLISH" else _upper_wick(candle)
    wick_to_body = wick / max(1e-12, body)
    wick_to_range = wick / rng

    cs = _close_strength(candle, direction)

    # rejection rule
    reject_ok = (
        wick_to_body >= cfg.min_wick_to_body
        and wick_to_range >= cfg.min_wick_to_range
        and cs >= cfg.min_close_strength
    )

    engulf_ok = cfg.allow_engulf_confirmation and _is_engulf(prev, candle, direction)

    ok = bool(reject_ok or engulf_ok)

    # score
    wick_score = _clip01(0.5 * (wick_to_body / max(1e-9, cfg.min_wick_to_body) - 1.0) +
                         0.5 * (wick_to_range / max(1e-9, cfg.min_wick_to_range) - 1.0))
    close_score = _clip01((cs - cfg.min_close_strength) / max(1e-9, (1.0 - cfg.min_close_strength)))
    engulf_score = 1.0 if engulf_ok else 0.0

    score01 = _clip01(0.50 * wick_score + 0.35 * close_score + 0.15 * engulf_score)

    return ok, score01, {
        "touched": touched,
        "reject_ok": reject_ok,
        "engulf_ok": engulf_ok,
        "wick_to_body": round(wick_to_body, 3),
        "wick_to_range": round(wick_to_range, 3),
        "close_strength": round(cs, 3),
        "score01": round(score01, 3),
    }
