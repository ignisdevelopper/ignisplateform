"""
core/sd_zones/ftb_detector.py — FTB (First Time Back) detector (IGNIS / HLZ)

FTB = "Premier retour" sur une zone S&D (SGB/SDE) après le départ (departure).
C’est un concept de "freshness" :
- touches == 0  => zone encore fraîche (pas de FTB pris)
- touches == 1  => FTB pris (événement majeur)
- touches >= N  => zone potentiellement affaiblie / WB (selon règles)

Ce module :
- Compte les touches (clusters) sur une zone après sa création + departure
- Détermine l’état :
  • APPROACHING : prix proche (proximité)
  • HIT         : touche confirmée (premier touch)
  • TAKEN       : FTB déjà pris (touches >= 1)
  • EXHAUSTED   : trop de touches (>= max_touches)

Design :
- Stateless
- Tolérant : candles dict/obj (open/high/low/close)
- zone dict/obj (zone_top/zone_bot/zone_type)
- creation_index optionnel (index de création zone / base_end / sde_index)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers (candles / zone) — tolérant dict/obj
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


def _infer_side(zone_type: str) -> tuple[bool, bool]:
    z = (zone_type or "").upper()
    is_demand = any(k in z for k in ("DEMAND", "FLIPPY_D", "HIDDEN_D"))
    is_supply = any(k in z for k in ("SUPPLY", "FLIPPY_S", "HIDDEN_S"))
    return is_demand, is_supply


def _intersects(high: float, low: float, top: float, bot: float) -> bool:
    return not (high < bot or low > top)


def _distance_to_zone(price: float, top: float, bot: float) -> float:
    """Distance au plus proche bord de zone (0 si dans la zone)."""
    if price > top:
        return price - top
    if price < bot:
        return bot - price
    return 0.0


def _pct_distance(a: float, b: float) -> float:
    if b == 0:
        return 999.0
    return abs(a - b) / abs(b)


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class FTBConfig:
    lookback: int = 1200
    atr_period: int = 14

    # Departure requirement (important pour éviter compter touches "pendant la création")
    require_departure: bool = True
    departure_window: int = 12
    min_departure_atr_mult: float = 0.75
    departure_close_buffer_atr_mult: float = 0.05

    # Touch counting
    touch_mode: str = "overlap"            # "overlap" | "close_inside"
    min_separation_bars: int = 2           # séparation mini entre clusters de touches
    ignore_bars_after_creation: int = 1    # ignore les 1-2 bougies post création

    # Freshness
    max_touches_for_fresh: int = 1         # 0 => fresh, 1 => FTB taken
    max_touches: int = 2                   # au-delà => EXHAUSTED (WB probable)

    # Proximity (approaching)
    proximity_atr_mult: float = 0.60
    proximity_pct: float = 0.005           # fallback si ATR=0 (0.5%)

    # Reaction check after touch (informatif, pas bloquant)
    reaction_window: int = 6
    min_reaction_atr_mult: float = 0.25


@dataclass
class FTBResult:
    """
    ftb_state :
      - "FRESH"       : 0 touches, prix loin
      - "APPROACHING" : 0 touches, prix proche
      - "HIT"         : 1er touch détecté (FTB pris)
      - "TAKEN"       : touches >= 1 (FTB déjà pris)
      - "EXHAUSTED"   : touches >= max_touches (zone trop touchée)
      - "NO_DEPARTURE": departure pas confirmé (si require_departure)
    """
    detected: bool = False
    ftb_state: str = ""
    ftb_valid: bool = False            # True uniquement si touches==0 et état fresh/approaching
    ftb_taken: bool = False            # True si touches>=1
    touches: int = 0

    zone_type: Optional[str] = None
    side: str = ""                     # "DEMAND" | "SUPPLY"
    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None

    atr: Optional[float] = None
    creation_index: Optional[int] = None
    departure_index: Optional[int] = None
    first_touch_index: Optional[int] = None
    last_touch_index: Optional[int] = None

    approaching: bool = False
    price: Optional[float] = None
    distance_to_zone: Optional[float] = None
    distance_pct: Optional[float] = None
    distance_atr: Optional[float] = None

    last_touch_penetration_pct: Optional[float] = None
    last_touch_reaction_atr: Optional[float] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class FTBDetector:
    """
    Détecteur FTB (First Time Back).

    Entrées attendues :
      - candles : list OHLC
      - zone    : dict/obj with zone_top, zone_bot, zone_type
      - creation_index (optional) : index où la zone est créée/validée (SGB/SDE/base_end)
    """

    def __init__(self, config: Optional[FTBConfig] = None) -> None:
        self.config = config or FTBConfig()

    def detect(
        self,
        candles: list[Any],
        *,
        zone: Any,
        creation_index: Optional[int] = None,
        current_price: Optional[float] = None,
    ) -> FTBResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 60):
            return FTBResult(detected=False, ftb_state="INVALID", details={"reason": "not_enough_candles"})

        if zone is None:
            return FTBResult(detected=False, ftb_state="INVALID", details={"reason": "zone_required"})

        zone_top = _z_get(zone, "zone_top")
        zone_bot = _z_get(zone, "zone_bot")
        zone_type = str(_z_get(zone, "zone_type", "") or _z_get(zone, "type", "") or _z_get(zone, "zoneType", ""))

        if zone_top is None or zone_bot is None:
            return FTBResult(
                detected=False,
                ftb_state="INVALID",
                zone_type=zone_type or None,
                details={"reason": "zone_missing_bounds"},
            )

        zt, zb = _normalize_bounds(float(zone_top), float(zone_bot))
        is_demand, is_supply = _infer_side(zone_type)
        if not (is_demand or is_supply):
            # fallback by last close vs zone mid
            mid = (zt + zb) / 2
            is_demand = _c_get(candles[-1], "close") <= mid
            is_supply = not is_demand

        side = "DEMAND" if is_demand else "SUPPLY"

        # Slice lookback (for performance)
        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            atr = 0.0

        price = float(current_price) if current_price is not None else _c_get(candles[-1], "close")

        # Resolve creation_index
        if creation_index is None:
            creation_index = (
                _z_get(zone, "created_index")
                or _z_get(zone, "sde_index")
                or _z_get(zone, "sgb_index")
                or _z_get(zone, "base_end_index")
            )
        if creation_index is None:
            # fallback: zone assumed recent
            creation_index = max(0, len(candles) - 200)

        creation_index = int(max(0, min(len(candles) - 1, creation_index)))

        # Convert to local index in slice
        local_creation = max(0, creation_index - offset)
        local_creation = min(local_creation, len(c) - 1)

        # ── Departure check ─────────────────────────────────────────────────
        departure_index = None
        departure_ok = True
        departure_meta: dict[str, Any] = {"enabled": cfg.require_departure}

        if cfg.require_departure:
            departure_ok, departure_index, departure_meta = _check_departure_away(
                candles=c,
                local_creation=local_creation,
                zone_top=zt,
                zone_bot=zb,
                side=side,
                atr=atr,
                cfg=cfg,
            )

            if not departure_ok:
                # We still compute proximity/touches but mark state NO_DEPARTURE
                dist = _distance_to_zone(price, zt, zb)
                dist_pct = _pct_distance(price, (zt + zb) / 2) * 100
                dist_atr = (dist / atr) if atr > 0 else None

                return FTBResult(
                    detected=True,
                    ftb_state="NO_DEPARTURE",
                    ftb_valid=False,
                    ftb_taken=False,
                    touches=0,
                    zone_type=zone_type or None,
                    side=side,
                    zone_top=float(zt),
                    zone_bot=float(zb),
                    atr=float(atr),
                    creation_index=creation_index,
                    departure_index=(offset + departure_index) if departure_index is not None else None,
                    approaching=False,
                    price=float(price),
                    distance_to_zone=float(dist),
                    distance_pct=float(round(dist_pct, 4)),
                    distance_atr=float(round(dist_atr, 4)) if dist_atr is not None else None,
                    details={
                        "departure": departure_meta,
                        "reason": "departure_not_confirmed",
                    },
                )

        # Start counting touches after departure (recommended)
        count_start = (departure_index + 1) if departure_index is not None else (local_creation + 1)
        count_start = min(len(c) - 1, count_start + cfg.ignore_bars_after_creation)

        touches, first_touch, last_touch, clusters = _count_touch_clusters(
            candles=c,
            start=count_start,
            end=len(c) - 1,
            zone_top=zt,
            zone_bot=zb,
            touch_mode=cfg.touch_mode,
            min_sep=cfg.min_separation_bars,
        )

        # ── Proximity (approaching) ─────────────────────────────────────────
        dist = _distance_to_zone(price, zt, zb)
        dist_pct = _pct_distance(price, (zt + zb) / 2)
        dist_atr = (dist / atr) if atr > 0 else None

        if dist == 0:
            approaching = True
        elif atr > 0:
            approaching = dist <= cfg.proximity_atr_mult * atr
        else:
            approaching = dist_pct <= cfg.proximity_pct

        # ── Touch extras: penetration + reaction on last touch (if any) ─────
        last_pen = None
        last_reaction = None
        if touches > 0 and clusters:
            last_cluster = clusters[-1]
            last_pen = _penetration_pct(
                candles=c,
                cluster=last_cluster,
                zone_top=zt,
                zone_bot=zb,
                side=side,
            )
            last_reaction = _reaction_after_touch_atr(
                candles=c,
                cluster=last_cluster,
                zone_top=zt,
                zone_bot=zb,
                side=side,
                atr=atr,
                window=cfg.reaction_window,
            )

        # ── State logic ─────────────────────────────────────────────────────
        ftb_taken = touches >= 1
        exhausted = touches >= cfg.max_touches

        if exhausted:
            ftb_state = "EXHAUSTED"
            ftb_valid = False
        elif ftb_taken:
            ftb_state = "HIT" if touches == 1 else "TAKEN"
            ftb_valid = False
        else:
            ftb_state = "APPROACHING" if approaching else "FRESH"
            ftb_valid = True

        return FTBResult(
            detected=True,
            ftb_state=ftb_state,
            ftb_valid=bool(ftb_valid),
            ftb_taken=bool(ftb_taken),
            touches=int(touches),
            zone_type=zone_type or None,
            side=side,
            zone_top=float(zt),
            zone_bot=float(zb),
            atr=float(atr),
            creation_index=int(creation_index),
            departure_index=(offset + departure_index) if departure_index is not None else None,
            first_touch_index=(offset + first_touch) if first_touch is not None else None,
            last_touch_index=(offset + last_touch) if last_touch is not None else None,
            approaching=bool(approaching),
            price=float(price),
            distance_to_zone=float(dist),
            distance_pct=float(round(dist_pct * 100, 4)),
            distance_atr=float(round(dist_atr, 4)) if dist_atr is not None else None,
            last_touch_penetration_pct=float(round(last_pen, 4)) if last_pen is not None else None,
            last_touch_reaction_atr=float(round(last_reaction, 4)) if last_reaction is not None else None,
            details={
                "departure": departure_meta,
                "touches": {
                    "count_start": offset + count_start,
                    "clusters": [{"start": offset + x["start"], "end": offset + x["end"]} for x in clusters],
                },
                "config": {
                    "touch_mode": cfg.touch_mode,
                    "max_touches_for_fresh": cfg.max_touches_for_fresh,
                    "max_touches": cfg.max_touches,
                    "proximity_atr_mult": cfg.proximity_atr_mult,
                    "proximity_pct": cfg.proximity_pct,
                },
            },
        )


# ═════════════════════════════════════════════════════════════════════════════=
# Internals
# ═════════════════════════════════════════════════════════════════════════════=

def _check_departure_away(
    *,
    candles: list[Any],
    local_creation: int,
    zone_top: float,
    zone_bot: float,
    side: str,
    atr: float,
    cfg: FTBConfig,
) -> tuple[bool, Optional[int], dict[str, Any]]:
    """
    Départ "away" :
    - DEMAND : close au-dessus zone_top + buffer et extension >= min_departure_atr_mult*ATR
    - SUPPLY : close en-dessous zone_bot - buffer et extension >= min_departure_atr_mult*ATR
    """
    if atr <= 0:
        # Without ATR, we still consider departure OK (can't robustly evaluate)
        return True, None, {"enabled": True, "reason": "atr_not_available"}

    start = min(len(candles) - 1, local_creation + 1)
    end = min(len(candles) - 1, start + max(1, cfg.departure_window) - 1)

    buf = cfg.departure_close_buffer_atr_mult * atr
    min_move = cfg.min_departure_atr_mult * atr

    if start > end:
        return False, None, {"enabled": True, "reason": "no_bars_after_creation"}

    if side == "DEMAND":
        # departure up
        best_idx = None
        best_ext = 0.0
        for i in range(start, end + 1):
            cl = _c_get(candles[i], "close")
            if cl < (zone_top + buf):
                continue
            # extension : max_high - zone_top
            ext = max(0.0, _c_get(candles[i], "high") - zone_top)
            if ext > best_ext:
                best_ext = ext
                best_idx = i

        ok = best_idx is not None and best_ext >= min_move
        return ok, best_idx, {
            "enabled": True,
            "side": side,
            "buffer": buf,
            "min_move": min_move,
            "best_extension": best_ext,
            "best_extension_atr": round(best_ext / atr, 3),
            "departure_index": best_idx,
            "ok": ok,
        }

    # SUPPLY: departure down
    best_idx = None
    best_ext = 0.0
    for i in range(start, end + 1):
        cl = _c_get(candles[i], "close")
        if cl > (zone_bot - buf):
            continue
        ext = max(0.0, zone_bot - _c_get(candles[i], "low"))
        if ext > best_ext:
            best_ext = ext
            best_idx = i

    ok = best_idx is not None and best_ext >= min_move
    return ok, best_idx, {
        "enabled": True,
        "side": side,
        "buffer": buf,
        "min_move": min_move,
        "best_extension": best_ext,
        "best_extension_atr": round(best_ext / atr, 3),
        "departure_index": best_idx,
        "ok": ok,
    }


def _count_touch_clusters(
    *,
    candles: list[Any],
    start: int,
    end: int,
    zone_top: float,
    zone_bot: float,
    touch_mode: str,
    min_sep: int,
) -> tuple[int, Optional[int], Optional[int], list[dict[str, int]]]:
    """
    Touch = cluster de bougies qui touchent la zone.
    Returns:
      touches_count, first_touch_index, last_touch_index, clusters
    """
    if not candles:
        return 0, None, None, []

    start = max(0, start)
    end = min(len(candles) - 1, end)
    if start > end:
        return 0, None, None, []

    clusters: list[dict[str, int]] = []
    touches = 0
    in_touch = False
    last_end = -10_000

    for i in range(start, end + 1):
        hi = _c_get(candles[i], "high")
        lo = _c_get(candles[i], "low")
        cl = _c_get(candles[i], "close")

        if touch_mode == "close_inside":
            hit = (zone_bot <= cl <= zone_top)
        else:
            hit = _intersects(hi, lo, zone_top, zone_bot)

        if hit and not in_touch:
            # merge clusters if too close
            if clusters and (i - last_end) <= max(0, min_sep):
                clusters[-1]["end"] = i
                in_touch = True
            else:
                clusters.append({"start": i, "end": i})
                touches += 1
                in_touch = True

        elif hit and in_touch:
            clusters[-1]["end"] = i

        elif (not hit) and in_touch:
            in_touch = False
            last_end = clusters[-1]["end"]

    first_touch = clusters[0]["start"] if clusters else None
    last_touch = clusters[-1]["end"] if clusters else None
    return touches, first_touch, last_touch, clusters


def _penetration_pct(
    *,
    candles: list[Any],
    cluster: dict[str, int],
    zone_top: float,
    zone_bot: float,
    side: str,
) -> float:
    """
    Pénétration normalisée 0..1 dans la zone, sur le cluster.
    - DEMAND : profondeur depuis top vers bot via min low
    - SUPPLY : profondeur depuis bot vers top via max high
    """
    height = max(1e-12, zone_top - zone_bot)
    s, e = cluster["start"], cluster["end"]
    win = candles[s : e + 1]
    if not win:
        return 0.0

    if side == "DEMAND":
        min_low = min(_c_get(x, "low") for x in win)
        pen = max(0.0, zone_top - min_low) / height
    else:
        max_high = max(_c_get(x, "high") for x in win)
        pen = max(0.0, max_high - zone_bot) / height

    return _clip01(pen)


def _reaction_after_touch_atr(
    *,
    candles: list[Any],
    cluster: dict[str, int],
    zone_top: float,
    zone_bot: float,
    side: str,
    atr: float,
    window: int,
) -> float:
    """
    Mesure la réaction après le touch, en ATR.
    - DEMAND : max_high - zone_top
    - SUPPLY : zone_bot - min_low
    """
    if atr <= 0:
        return 0.0
    end_idx = cluster["end"]
    start = end_idx + 1
    end = min(len(candles) - 1, start + max(1, window) - 1)
    if start > end:
        return 0.0

    win = candles[start : end + 1]
    if not win:
        return 0.0

    if side == "DEMAND":
        max_high = max(_c_get(x, "high") for x in win)
        move = max(0.0, max_high - zone_top)
    else:
        min_low = min(_c_get(x, "low") for x in win)
        move = max(0.0, zone_bot - min_low)

    return move / atr