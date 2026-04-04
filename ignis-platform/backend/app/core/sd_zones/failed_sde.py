"""
core/sd_zones/failed_sde.py — Failed SDE rules detector (IGNIS / HLZ)

Rôle :
- Déterminer si une zone S&D issue d’un SDE doit être considérée comme "FAILED"
  (invalidée / départ non valide / trop de retours).
- Fournit des règles génériques et robustes pour le pipeline.

Rappels HLZ (générique) :
- DEMAND : invalidation si le prix clôture sous le distal (zone_bot) avec un buffer.
- SUPPLY : invalidation si le prix clôture au-dessus du distal (zone_top) avec un buffer.
- Un SDE peut aussi être considéré "failed" si :
  • départ (departure) insuffisant après la création,
  • trop de touches (freshness perdue) avant réaction,
  • reversal précoce (réintégration agressive) juste après SDE.

Design :
- Stateless
- Tolérant : candles dict/obj (open/high/low/close)
- Zone en dict/obj (zone_top, zone_bot, zone_type + optional sde_index/created_index)

Sortie :
- FailedSDEResult : failed(bool) + reason + indices + métriques
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Candle / Zone helpers (tolérant)
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


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class FailedSDEConfig:
    atr_period: int = 14

    # Hard invalidation (close through distal)
    invalidation_buffer_atr_mult: float = 0.05
    invalidation_buffer_pct: float = 0.0010   # fallback si ATR=0 (0.10%)

    # Departure requirement (après création zone/sde)
    departure_window: int = 6
    min_departure_atr_mult: float = 0.75

    # Early reversal (réintégration agressive peu après le SDE)
    early_window: int = 4
    early_reversal_atr_mult: float = 0.35

    # Touch / freshness (proxy)
    touches_lookahead: int = 300
    ignore_first_bars_after_creation: int = 1
    min_separation_bars: int = 2
    max_touches_before_fail: int = 3

    # Mode failure logic
    fail_on_no_departure: bool = True
    fail_on_too_many_touches: bool = False   # souvent plutôt "WB" que "Failed", au choix


@dataclass
class FailedSDEResult:
    failed: bool = False
    reason: str = ""                    # INVALIDATED | NO_DEPARTURE | EARLY_REVERSAL | TOO_MANY_TOUCHES | ...

    zone_type: Optional[str] = None
    side: str = ""                      # DEMAND | SUPPLY
    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None

    atr: Optional[float] = None
    creation_index: Optional[int] = None

    invalidated: bool = False
    invalidation_index: Optional[int] = None
    invalidation_close: Optional[float] = None
    invalidation_level: Optional[float] = None

    departure_ok: bool = True
    departure_move: Optional[float] = None
    departure_move_atr: Optional[float] = None

    touches: int = 0
    first_touch_index: Optional[int] = None
    last_touch_index: Optional[int] = None

    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "failed": self.failed,
            "reason": self.reason,
            "zone_type": self.zone_type,
            "side": self.side,
            "zone_top": self.zone_top,
            "zone_bot": self.zone_bot,
            "atr": self.atr,
            "creation_index": self.creation_index,
            "invalidated": self.invalidated,
            "invalidation_index": self.invalidation_index,
            "invalidation_close": self.invalidation_close,
            "invalidation_level": self.invalidation_level,
            "departure_ok": self.departure_ok,
            "departure_move": self.departure_move,
            "departure_move_atr": self.departure_move_atr,
            "touches": self.touches,
            "first_touch_index": self.first_touch_index,
            "last_touch_index": self.last_touch_index,
            "details": self.details,
        }


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class FailedSDEDetector:
    """
    Détecte si une zone (issue d'un SDE) est FAILED.

    Entrées attendues :
      - candles : list OHLC
      - zone : dict/obj avec au minimum zone_top/zone_bot/zone_type
    Champs optionnels (si disponibles) :
      - zone["sde_index"] / zone["created_index"] / zone["base_end_index"] / zone["timestamp_index"]
    """

    def __init__(self, config: Optional[FailedSDEConfig] = None) -> None:
        self.config = config or FailedSDEConfig()

    def detect(
        self,
        candles: list[Any],
        *,
        zone: Any,
        creation_index: Optional[int] = None,
    ) -> FailedSDEResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 30):
            return FailedSDEResult(failed=False, reason="NOT_ENOUGH_CANDLES", details={"reason": "not_enough_candles"})

        if zone is None:
            return FailedSDEResult(failed=False, reason="ZONE_REQUIRED", details={"reason": "zone_required"})

        zone_top = _z_get(zone, "zone_top")
        zone_bot = _z_get(zone, "zone_bot")
        zone_type = str(_z_get(zone, "zone_type", "") or _z_get(zone, "type", "") or _z_get(zone, "zoneType", ""))

        if zone_top is None or zone_bot is None:
            return FailedSDEResult(failed=False, reason="ZONE_MISSING_BOUNDS", zone_type=zone_type or None, details={"reason": "zone_missing_bounds"})

        zt, zb = _normalize_bounds(float(zone_top), float(zone_bot))

        is_demand, is_supply = _infer_side(zone_type)
        if not (is_demand or is_supply):
            # fallback: infer by last close vs zone mid
            mid = (zt + zb) / 2
            is_demand = _c_get(candles[-1], "close") <= mid
            is_supply = not is_demand

        side = "DEMAND" if is_demand else "SUPPLY"

        atr = _compute_atr(candles, cfg.atr_period)
        if atr <= 0:
            atr = 0.0

        # Resolve creation index
        if creation_index is None:
            creation_index = (
                _z_get(zone, "sde_index")
                or _z_get(zone, "created_index")
                or _z_get(zone, "base_end_index")
                or _z_get(zone, "timestamp_index")
            )
        if creation_index is None:
            # fallback: assume zone is "recent" and analyze all candles
            creation_index = max(0, len(candles) - 100)

        creation_index = int(max(0, min(len(candles) - 1, creation_index)))

        # Compute invalidation level with buffer
        if atr > 0:
            buf = cfg.invalidation_buffer_atr_mult * atr
        else:
            # fallback: buffer proportional to distal edge
            distal_ref = zb if side == "DEMAND" else zt
            buf = cfg.invalidation_buffer_pct * distal_ref

        invalidation_level = (zb - buf) if side == "DEMAND" else (zt + buf)

        # ── 1) Hard invalidation scan ───────────────────────────────────────
        inv_idx = None
        inv_close = None

        scan_start = min(len(candles) - 1, creation_index + 1)
        for i in range(scan_start, len(candles)):
            cl = _c_get(candles[i], "close")
            if side == "DEMAND":
                if cl < invalidation_level:
                    inv_idx = i
                    inv_close = cl
                    break
            else:
                if cl > invalidation_level:
                    inv_idx = i
                    inv_close = cl
                    break

        if inv_idx is not None:
            return FailedSDEResult(
                failed=True,
                reason="INVALIDATED",
                zone_type=zone_type or None,
                side=side,
                zone_top=float(zt),
                zone_bot=float(zb),
                atr=float(atr),
                creation_index=creation_index,
                invalidated=True,
                invalidation_index=int(inv_idx),
                invalidation_close=float(inv_close) if inv_close is not None else None,
                invalidation_level=float(invalidation_level),
                details={
                    "buffer": buf,
                    "rule": "close_through_distal",
                },
            )

        # ── 2) Departure check (optionnel) ───────────────────────────────────
        departure_ok = True
        departure_move = 0.0

        if cfg.fail_on_no_departure and atr > 0:
            dep_start = min(len(candles) - 1, creation_index + 1)
            dep_end = min(len(candles) - 1, dep_start + max(1, cfg.departure_window) - 1)

            if dep_start <= dep_end:
                win = candles[dep_start : dep_end + 1]
                if side == "DEMAND":
                    # away move: max high above zone_top
                    max_high = max(_c_get(x, "high") for x in win)
                    departure_move = max(0.0, max_high - zt)
                else:
                    min_low = min(_c_get(x, "low") for x in win)
                    departure_move = max(0.0, zb - min_low)

                min_req = cfg.min_departure_atr_mult * atr
                departure_ok = departure_move >= min_req
            else:
                departure_ok = False

            if not departure_ok:
                return FailedSDEResult(
                    failed=True,
                    reason="NO_DEPARTURE",
                    zone_type=zone_type or None,
                    side=side,
                    zone_top=float(zt),
                    zone_bot=float(zb),
                    atr=float(atr),
                    creation_index=creation_index,
                    invalidated=False,
                    invalidation_level=float(invalidation_level),
                    departure_ok=False,
                    departure_move=float(departure_move),
                    departure_move_atr=float(departure_move / atr) if atr > 0 else None,
                    details={
                        "rule": "departure_insufficient",
                        "departure_window": cfg.departure_window,
                        "min_departure_atr_mult": cfg.min_departure_atr_mult,
                    },
                )

        # ── 3) Early reversal check (optionnel) ──────────────────────────────
        # Simple proxy : après création, si prix revient rapidement "de l'autre côté" du proximal
        # de plus de early_reversal_atr_mult*ATR => weak SDE / manip.
        if atr > 0 and cfg.early_window > 0:
            ew_start = min(len(candles) - 1, creation_index + 1)
            ew_end = min(len(candles) - 1, ew_start + cfg.early_window - 1)
            if ew_start <= ew_end:
                win = candles[ew_start : ew_end + 1]
                thr = cfg.early_reversal_atr_mult * atr

                if side == "DEMAND":
                    # reversal: close retombe sous zone_top - thr
                    level = zt - thr
                    for j, cc in enumerate(win, start=ew_start):
                        if _c_get(cc, "close") < level:
                            return FailedSDEResult(
                                failed=True,
                                reason="EARLY_REVERSAL",
                                zone_type=zone_type or None,
                                side=side,
                                zone_top=float(zt),
                                zone_bot=float(zb),
                                atr=float(atr),
                                creation_index=creation_index,
                                invalidated=False,
                                invalidation_level=float(invalidation_level),
                                departure_ok=departure_ok,
                                departure_move=float(departure_move) if departure_move else None,
                                departure_move_atr=float(departure_move / atr) if atr > 0 else None,
                                details={
                                    "rule": "early_close_back_under_proximal",
                                    "window": cfg.early_window,
                                    "threshold_level": level,
                                    "threshold_atr_mult": cfg.early_reversal_atr_mult,
                                    "failure_index": j,
                                },
                            )
                else:
                    # supply: reversal close au-dessus zone_bot + thr
                    level = zb + thr
                    for j, cc in enumerate(win, start=ew_start):
                        if _c_get(cc, "close") > level:
                            return FailedSDEResult(
                                failed=True,
                                reason="EARLY_REVERSAL",
                                zone_type=zone_type or None,
                                side=side,
                                zone_top=float(zt),
                                zone_bot=float(zb),
                                atr=float(atr),
                                creation_index=creation_index,
                                invalidated=False,
                                invalidation_level=float(invalidation_level),
                                departure_ok=departure_ok,
                                departure_move=float(departure_move) if departure_move else None,
                                departure_move_atr=float(departure_move / atr) if atr > 0 else None,
                                details={
                                    "rule": "early_close_back_over_proximal",
                                    "window": cfg.early_window,
                                    "threshold_level": level,
                                    "threshold_atr_mult": cfg.early_reversal_atr_mult,
                                    "failure_index": j,
                                },
                            )

        # ── 4) Touches / freshness (optionnel) ───────────────────────────────
        touches, first_touch, last_touch, clusters = self._count_touches(
            candles=candles,
            start=min(len(candles) - 1, creation_index + 1 + cfg.ignore_first_bars_after_creation),
            end=min(len(candles) - 1, creation_index + cfg.touches_lookahead),
            zone_top=zt,
            zone_bot=zb,
            min_sep=cfg.min_separation_bars,
        )

        if cfg.fail_on_too_many_touches and touches >= cfg.max_touches_before_fail:
            return FailedSDEResult(
                failed=True,
                reason="TOO_MANY_TOUCHES",
                zone_type=zone_type or None,
                side=side,
                zone_top=float(zt),
                zone_bot=float(zb),
                atr=float(atr),
                creation_index=creation_index,
                invalidated=False,
                invalidation_level=float(invalidation_level),
                departure_ok=departure_ok,
                departure_move=float(departure_move) if departure_move else None,
                departure_move_atr=float(departure_move / atr) if atr > 0 else None,
                touches=touches,
                first_touch_index=first_touch,
                last_touch_index=last_touch,
                details={
                    "rule": "touches_gte_max",
                    "touches": touches,
                    "max_touches_before_fail": cfg.max_touches_before_fail,
                    "clusters": clusters,
                },
            )

        # Otherwise: not failed
        return FailedSDEResult(
            failed=False,
            reason="OK",
            zone_type=zone_type or None,
            side=side,
            zone_top=float(zt),
            zone_bot=float(zb),
            atr=float(atr),
            creation_index=creation_index,
            invalidated=False,
            invalidation_level=float(invalidation_level),
            departure_ok=departure_ok,
            departure_move=float(departure_move) if departure_move else None,
            departure_move_atr=float(departure_move / atr) if (atr > 0 and departure_move is not None) else None,
            touches=touches,
            first_touch_index=first_touch,
            last_touch_index=last_touch,
            details={
                "buffer": buf,
                "touches_clusters": clusters,
                "config": {
                    "fail_on_no_departure": cfg.fail_on_no_departure,
                    "fail_on_too_many_touches": cfg.fail_on_too_many_touches,
                },
            },
        )

    @staticmethod
    def _count_touches(
        *,
        candles: list[Any],
        start: int,
        end: int,
        zone_top: float,
        zone_bot: float,
        min_sep: int,
    ) -> tuple[int, Optional[int], Optional[int], list[dict[str, int]]]:
        """
        Touch = cluster de bougies dont le range intersecte la zone.
        Retourne (touches, first_touch_index, last_touch_index, clusters)
        """
        if not candles or start >= len(candles):
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
            hit = _intersects(hi, lo, zone_top, zone_bot)

            if hit and not in_touch:
                # If too close to previous cluster, merge
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
