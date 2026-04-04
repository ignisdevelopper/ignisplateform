"""
core/pa_patterns/pattern_69.py — Pattern 69 detector (IGNIS / HLZ)

Pattern 69 (HLZ) = confluence forte :
- FLIPPY (ancienne S->D ou D->S) + SDE + SGB alignés

Interprétation pratique :
- C’est un PA pattern (Price Approaching) : on veut savoir si la "config 69" existe,
  et si le prix est en train de revenir (ou proche) de la zone d’entrée.

Ce détecteur est volontairement hybride :
- Mode "metadata-first" : si le pipeline fournit déjà zone/sde/base scores → très fiable.
- Mode fallback : si certaines infos manquent, on infère un minimum depuis zone_type / payload.

Entrées (tolérantes dict/obj) :
- candles : list[OHLC]
- zone    : dict|obj (zone_top, zone_bot, zone_type, is_flippy, base_type, base_score, score, ...)
- sde     : dict|obj optionnel (detected, score, engulf_ratio, ...)
- base    : dict|obj optionnel (base_type, score, ...)
- current_price : float optionnel (sinon last close)

Sortie :
- Pattern69Result (detected + status + direction + strength + meta)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers — candles / objects (tolérant dict/obj)
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


def _normalize_zone_bounds(zone_top: float, zone_bot: float) -> tuple[float, float]:
    zt = float(zone_top)
    zb = float(zone_bot)
    return (zt, zb) if zt >= zb else (zb, zt)


def _distance_to_zone(price: float, zone_top: float, zone_bot: float) -> float:
    """Distance au plus proche bord de zone (0 si dans la zone)."""
    if price > zone_top:
        return price - zone_top
    if price < zone_bot:
        return zone_bot - price
    return 0.0


def _pct_distance(a: float, b: float) -> float:
    if b == 0:
        return 999.0
    return abs(a - b) / abs(b)


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


def _infer_from_zone_type(zone_type: str) -> tuple[bool, bool]:
    """
    Returns (is_flippy, direction_is_bullish).
    - FLIPPY_D => bullish
    - FLIPPY_S => bearish
    """
    z = (zone_type or "").upper()
    is_flippy = "FLIPPY" in z
    if "FLIPPY_D" in z or ("DEMAND" in z and "FLIPPY" in z):
        return is_flippy, True
    if "FLIPPY_S" in z or ("SUPPLY" in z and "FLIPPY" in z):
        return is_flippy, False

    # fallback : if just "DEMAND" / "SUPPLY"
    if "DEMAND" in z:
        return is_flippy, True
    if "SUPPLY" in z:
        return is_flippy, False
    return is_flippy, True


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class Pattern69Config:
    lookback: int = 240
    atr_period: int = 14

    # Requirements
    require_flippy: bool = True
    require_sde: bool = True
    require_sgb: bool = True

    # Proximity (price vs zone)
    proximity_atr_mult: float = 0.75      # "READY" si dist <= X*ATR
    proximity_pct: float = 0.006          # fallback si ATR=0 (0.6%)
    in_zone_is_ready: bool = True

    # Scores mapping
    default_flippy_score01: float = 0.85  # si flippy détecté mais pas de score détaillé
    min_sde_score: int = 70               # si score SDE fourni (0..100)
    min_base_score: int = 60              # si score base fourni (0..100)

    # Weights
    w_flippy: float = 0.25
    w_sde: float = 0.35
    w_sgb: float = 0.25
    w_proximity: float = 0.15


@dataclass
class Pattern69Result:
    detected: bool = False
    status: str = ""                 # "FORMING" | "READY" | "INVALID"
    direction: str = ""              # "BULLISH" | "BEARISH"
    strength: int = 0                # 0..100

    zone_type: Optional[str] = None
    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None

    flippy: bool = False
    sde_ok: bool = False
    sgb_ok: bool = False

    price: Optional[float] = None
    distance_to_zone: Optional[float] = None
    distance_pct: Optional[float] = None
    atr: Optional[float] = None

    base_type: Optional[str] = None
    sde_score: Optional[int] = None
    base_score: Optional[int] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class Pattern69Detector:
    """
    Détecteur Pattern 69.
    """

    def __init__(self, config: Optional[Pattern69Config] = None) -> None:
        self.config = config or Pattern69Config()

    def detect(
        self,
        candles: list[Any],
        *,
        zone: Optional[Any] = None,
        sde: Optional[Any] = None,
        base: Optional[Any] = None,
        current_price: Optional[float] = None,
    ) -> Pattern69Result:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 60):
            return Pattern69Result(detected=False, status="INVALID", details={"reason": "not_enough_candles"})

        # Focus lookback for ATR stability
        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]

        atr = _compute_atr(c, cfg.atr_period)
        price = float(current_price) if current_price is not None else _c_get(candles[-1], "close")

        if zone is None:
            return Pattern69Result(detected=False, status="INVALID", price=price, atr=float(atr), details={"reason": "zone_required"})

        zone_top = _o_get(zone, "zone_top")
        zone_bot = _o_get(zone, "zone_bot")
        zone_type = str(_o_get(zone, "zone_type", "") or _o_get(zone, "type", "") or _o_get(zone, "zoneType", ""))

        if zone_top is None or zone_bot is None:
            return Pattern69Result(detected=False, status="INVALID", price=price, atr=float(atr), zone_type=zone_type or None, details={"reason": "zone_missing_bounds"})

        zt, zb = _normalize_zone_bounds(float(zone_top), float(zone_bot))

        # ── FLIPPY ──────────────────────────────────────────────────────────
        flippy_flag = bool(_o_get(zone, "is_flippy", False))
        is_flippy_by_type, dir_is_bull = _infer_from_zone_type(zone_type)
        flippy = bool(flippy_flag or is_flippy_by_type)

        if cfg.require_flippy and not flippy:
            return Pattern69Result(
                detected=False,
                status="INVALID",
                price=price,
                atr=float(atr),
                zone_type=zone_type or None,
                zone_top=zt,
                zone_bot=zb,
                flippy=flippy,
                details={"reason": "flippy_required"},
            )

        direction = "BULLISH" if dir_is_bull else "BEARISH"

        # ── SDE OK (metadata-first) ─────────────────────────────────────────
        sde_ok, sde_score = _evaluate_sde(sde=sde, zone=zone, cfg=cfg)

        if cfg.require_sde and not sde_ok:
            return Pattern69Result(
                detected=False,
                status="INVALID",
                direction=direction,
                price=price,
                atr=float(atr),
                zone_type=zone_type or None,
                zone_top=zt,
                zone_bot=zb,
                flippy=flippy,
                sde_ok=sde_ok,
                sde_score=sde_score,
                details={"reason": "sde_required_or_too_weak"},
            )

        # ── SGB OK (metadata-first) ─────────────────────────────────────────
        sgb_ok, base_type, base_score = _evaluate_sgb(base=base, zone=zone, cfg=cfg)

        if cfg.require_sgb and not sgb_ok:
            return Pattern69Result(
                detected=False,
                status="INVALID",
                direction=direction,
                price=price,
                atr=float(atr),
                zone_type=zone_type or None,
                zone_top=zt,
                zone_bot=zb,
                flippy=flippy,
                sde_ok=sde_ok,
                sgb_ok=sgb_ok,
                sde_score=sde_score,
                base_type=base_type,
                base_score=base_score,
                details={"reason": "sgb_required_or_too_weak"},
            )

        # ── Proximity / status READY vs FORMING ─────────────────────────────
        dist = _distance_to_zone(price, zt, zb)
        dist_pct = _pct_distance(price, (zt + zb) / 2)

        if dist == 0.0 and cfg.in_zone_is_ready:
            proximity_score01 = 1.0
            status = "READY"
        else:
            if atr and atr > 0:
                proximity_score01 = _clip01(1.0 - dist / max(1e-12, cfg.proximity_atr_mult * atr))
                status = "READY" if dist <= cfg.proximity_atr_mult * atr else "FORMING"
            else:
                proximity_score01 = _clip01(1.0 - dist_pct / max(1e-12, cfg.proximity_pct))
                status = "READY" if dist_pct <= cfg.proximity_pct else "FORMING"

        # ── Strength score ──────────────────────────────────────────────────
        # flippy score (if score provided in zone payload, use it)
        flippy_score01 = float(_o_get(zone, "flippy_score", None) or _o_get(zone, "flippy_strength", None) or 0.0)
        if flippy_score01 > 1.0:
            flippy_score01 = _clip01(flippy_score01 / 100.0)
        if flippy_score01 <= 0.0:
            flippy_score01 = cfg.default_flippy_score01 if flippy else 0.0

        sde_score01 = _clip01((sde_score or 0) / 100.0) if sde_score is not None else (0.75 if sde_ok else 0.0)
        sgb_score01 = _clip01((base_score or 0) / 100.0) if base_score is not None else (0.70 if sgb_ok else 0.0)

        total01 = (
            cfg.w_flippy * flippy_score01
            + cfg.w_sde * sde_score01
            + cfg.w_sgb * sgb_score01
            + cfg.w_proximity * proximity_score01
        )
        strength = int(round(100 * _clip01(total01)))

        return Pattern69Result(
            detected=True,
            status=status,
            direction=direction,
            strength=strength,
            zone_type=zone_type or None,
            zone_top=float(zt),
            zone_bot=float(zb),
            flippy=flippy,
            sde_ok=sde_ok,
            sgb_ok=sgb_ok,
            price=float(price),
            distance_to_zone=float(dist),
            distance_pct=float(round(dist_pct * 100, 4)),
            atr=float(atr),
            base_type=base_type,
            sde_score=sde_score,
            base_score=base_score,
            details={
                "scores01": {
                    "flippy": round(flippy_score01, 3),
                    "sde": round(sde_score01, 3),
                    "sgb": round(sgb_score01, 3),
                    "proximity": round(proximity_score01, 3),
                    "total01": round(_clip01(total01), 3),
                },
                "checks": {
                    "require_flippy": cfg.require_flippy,
                    "require_sde": cfg.require_sde,
                    "require_sgb": cfg.require_sgb,
                },
            },
        )


# ═════════════════════════════════════════════════════════════════════════════=
# Internals — SDE/SGB evaluation (metadata-first)
# ═════════════════════════════════════════════════════════════════════════════=

def _evaluate_sde(*, sde: Optional[Any], zone: Any, cfg: Pattern69Config) -> tuple[bool, Optional[int]]:
    """
    Returns (sde_ok, sde_score_int_0_100_or_None).
    Accepts multiple common keys.
    """
    # try direct sde object
    if sde is not None:
        detected = bool(_o_get(sde, "detected", False) or _o_get(sde, "is_sde", False) or _o_get(sde, "sde_detected", False))
        score = _o_get(sde, "score", None) or _o_get(sde, "strength", None)
        engulf_ratio = _o_get(sde, "engulf_ratio", None) or _o_get(sde, "engulfment_ratio", None)

        if score is not None:
            try:
                sc = int(score)
            except Exception:
                sc = None
        else:
            sc = None

        if sc is None and engulf_ratio is not None:
            try:
                sc = int(round(100 * float(engulf_ratio)))
            except Exception:
                sc = None

        if detected and sc is None:
            # assume acceptable if detected but score missing
            return True, None

        if sc is not None:
            return (sc >= cfg.min_sde_score), sc

        return detected, sc

    # fallback: zone payload fields
    detected = bool(_o_get(zone, "sde_detected", False) or _o_get(zone, "has_sde", False) or _o_get(zone, "sde_ok", False))
    score = _o_get(zone, "sde_score", None) or _o_get(zone, "engulf_score", None)
    if score is not None:
        try:
            sc = int(score)
        except Exception:
            sc = None
        if sc is not None:
            return (sc >= cfg.min_sde_score), sc

    return detected, None


def _evaluate_sgb(*, base: Optional[Any], zone: Any, cfg: Pattern69Config) -> tuple[bool, Optional[str], Optional[int]]:
    """
    Returns (sgb_ok, base_type, base_score_int_or_None).
    """
    # direct base object
    if base is not None:
        btype = _o_get(base, "base_type", None) or _o_get(base, "type", None)
        score = _o_get(base, "score", None) or _o_get(base, "base_score", None) or _o_get(base, "strength", None)
        created = bool(_o_get(base, "detected", False) or _o_get(base, "created", False) or (btype is not None))

        sc = None
        if score is not None:
            try:
                sc = int(score)
            except Exception:
                sc = None

        if created and sc is None:
            return True, str(btype) if btype is not None else None, None

        if sc is not None:
            return (sc >= cfg.min_base_score), str(btype) if btype is not None else None, sc

        return created, str(btype) if btype is not None else None, sc

    # fallback: zone fields
    btype = _o_get(zone, "base_type", None) or _o_get(zone, "sgb_type", None)
    score = _o_get(zone, "base_score", None) or _o_get(zone, "sgb_score", None) or _o_get(zone, "score", None)

    created = bool(_o_get(zone, "sgb_created", False) or _o_get(zone, "has_sgb", False) or (btype is not None))

    sc = None
    if score is not None:
        try:
            sc = int(score)
        except Exception:
            sc = None

    if created and sc is None:
        return True, str(btype) if btype is not None else None, None

    if sc is not None:
        return (sc >= cfg.min_base_score), str(btype) if btype is not None else None, sc

    return created, str(btype) if btype is not None else None, sc
