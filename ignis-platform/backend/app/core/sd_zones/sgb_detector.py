"""
core/sd_zones/sgb_detector.py — SGB (Significant Base) detector (IGNIS / HLZ)

SGB = zone d’entrée (Supply/Demand) dérivée d’une base HLZ (RBR/DBD/RBD/DBR).

Objectif :
- À partir d’une base (idéalement détectée par BaseDetector), construire une zone S&D exploitable :
  • DEMAND : base avec départ bullish (RBR/DBR)
  • SUPPLY : base avec départ bearish (DBD/RBD)
- Calculer/associer un score de solidité (BaseScorer)
- Normaliser la zone : zone_top / zone_bot + proximal/distal

Conventions HLZ (générique) :
- Zone bounds : zone_top = niveau haut, zone_bot = niveau bas (toujours).
- Proximal / Distal :
    DEMAND : proximal = zone_top, distal = zone_bot
    SUPPLY : proximal = zone_bot, distal = zone_top
- Boundary modes :
    FULL   : top=high, bot=low (base entière)
    BODY   : top=max(open,close), bot=min(open,close) (base "body")
    MIXED  : proximal basé sur BODY, distal basé sur FULL (pratique HLZ)

Design :
- Stateless
- Tolérant : candles dict/obj, base dict/obj
- Peut auto-détecter une base si base=None (optionnel)

Sortie :
- SGBResult(created=True/False, zone_top/bot, zone_type, base_type, base_score, ...)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable, Literal

import structlog

from app import BaseType, ZoneType, SCORING_THRESHOLDS

log = structlog.get_logger(__name__)

BoundaryMode = Literal["FULL", "BODY", "MIXED"]


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


def _b_get(b: Any, key: str, default: Any = None) -> Any:
    if b is None:
        return default
    if isinstance(b, dict):
        return b.get(key, default)
    return getattr(b, key, default)


def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _normalize_bounds(top: float, bot: float) -> tuple[float, float]:
    top = float(top)
    bot = float(bot)
    return (top, bot) if top >= bot else (bot, top)


def _zone_type_from_base_type(base_type: str) -> Optional[str]:
    bt = (base_type or "").upper()
    if bt in (BaseType.RBR, BaseType.DBR):
        return ZoneType.DEMAND
    if bt in (BaseType.DBD, BaseType.RBD):
        return ZoneType.SUPPLY
    return None


def _prox_distal(zone_type: str, zone_top: float, zone_bot: float) -> tuple[float, float]:
    zt = (zone_type or "").upper()
    if "DEMAND" in zt:
        return zone_top, zone_bot
    if "SUPPLY" in zt:
        return zone_bot, zone_top
    # fallback
    return zone_top, zone_bot


def _compute_base_bounds_from_candles(
    base_candles: list[Any],
    *,
    mode: BoundaryMode,
    zone_type: str,
) -> tuple[float, float, dict[str, Any]]:
    """
    Retourne (zone_top, zone_bot, meta) pour la base selon boundary mode.
    """
    highs = [_c_get(x, "high") for x in base_candles]
    lows = [_c_get(x, "low") for x in base_candles]
    full_top = max(highs)
    full_bot = min(lows)

    bodies_top = max(max(_c_get(x, "open"), _c_get(x, "close")) for x in base_candles)
    bodies_bot = min(min(_c_get(x, "open"), _c_get(x, "close")) for x in base_candles)

    full_top, full_bot = _normalize_bounds(full_top, full_bot)
    body_top, body_bot = _normalize_bounds(bodies_top, bodies_bot)

    if mode == "FULL":
        ztop, zbot = full_top, full_bot
    elif mode == "BODY":
        ztop, zbot = body_top, body_bot
    else:
        # MIXED : proximal = body, distal = full
        # DEMAND: proximal top (body_top) ; distal bottom (full_bot)
        # SUPPLY: proximal bottom (body_bot) ; distal top (full_top)
        proximal, distal = _prox_distal(zone_type, zone_top=body_top, zone_bot=body_bot)
        if (zone_type or "").upper() in (ZoneType.DEMAND, "DEMAND") or "DEMAND" in (zone_type or "").upper():
            ztop = proximal        # body_top
            zbot = full_bot        # distal = full_bot
        else:
            ztop = full_top        # distal = full_top
            zbot = proximal        # body_bot
        ztop, zbot = _normalize_bounds(ztop, zbot)

    meta = {
        "full_top": full_top,
        "full_bot": full_bot,
        "body_top": body_top,
        "body_bot": body_bot,
        "mode": mode,
    }
    return float(ztop), float(zbot), meta


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class SGBConfig:
    lookback: int = 260

    # Base
    auto_detect_base_if_missing: bool = True
    boundary_mode: BoundaryMode = "MIXED"

    # Base score gating
    score_base: bool = True
    min_base_score: int = int(SCORING_THRESHOLDS.get("BASE_SOLID_MIN", 70))

    # If True, require base.detected True
    require_detected_base: bool = True

    # If multiple bases are provided (detect_all), pick best by strength then recency
    prefer_most_recent: bool = True


@dataclass
class SGBResult:
    created: bool = False
    reason: str = ""

    zone_type: Optional[str] = None        # ZoneType.DEMAND / ZoneType.SUPPLY
    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None
    proximal: Optional[float] = None
    distal: Optional[float] = None
    height: Optional[float] = None

    base_type: Optional[str] = None
    base_score: Optional[int] = None
    base_grade: Optional[str] = None

    base_start_index: Optional[int] = None
    base_end_index: Optional[int] = None
    created_index: Optional[int] = None    # par convention = base_end_index

    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "created": self.created,
            "reason": self.reason,
            "zone_type": self.zone_type,
            "zone_top": self.zone_top,
            "zone_bot": self.zone_bot,
            "proximal": self.proximal,
            "distal": self.distal,
            "height": self.height,
            "base_type": self.base_type,
            "base_score": self.base_score,
            "base_grade": self.base_grade,
            "base_start_index": self.base_start_index,
            "base_end_index": self.base_end_index,
            "created_index": self.created_index,
            "details": self.details,
        }


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class SGBDetector:
    """
    Détecte / construit une SGB à partir d'une base.
    """

    def __init__(self, config: Optional[SGBConfig] = None) -> None:
        self.config = config or SGBConfig()

    def detect(
        self,
        candles: list[Any],
        *,
        base: Optional[Any] = None,
    ) -> SGBResult:
        cfg = self.config

        if not candles or len(candles) < 20:
            return SGBResult(created=False, reason="NOT_ENOUGH_CANDLES")

        # Resolve base
        if base is None and cfg.auto_detect_base_if_missing:
            try:
                from app.core.base_engine.base_detector import BaseDetector
                base = BaseDetector().detect(candles)
            except Exception as exc:
                log.warning("sgb_base_autodetect_failed", error=str(exc))
                base = None

        if base is None:
            return SGBResult(created=False, reason="BASE_REQUIRED")

        detected = bool(_b_get(base, "detected", True))
        if cfg.require_detected_base and not detected:
            return SGBResult(created=False, reason="BASE_NOT_DETECTED")

        base_type = str(_b_get(base, "base_type", "") or _b_get(base, "type", "") or "")
        base_start = _b_get(base, "base_start_index")
        base_end = _b_get(base, "base_end_index")

        # bounds can be from base object, else compute from candles
        base_top = _b_get(base, "base_top")
        base_bot = _b_get(base, "base_bot")

        if base_start is None or base_end is None:
            return SGBResult(created=False, reason="BASE_MISSING_INDICES", base_type=base_type or None)

        base_start = int(base_start)
        base_end = int(base_end)

        if base_start < 0 or base_end >= len(candles) or base_end <= base_start:
            return SGBResult(
                created=False,
                reason="BASE_INDICES_INVALID",
                base_type=base_type or None,
                details={"base_start": base_start, "base_end": base_end, "candles_len": len(candles)},
            )

        ztype = _zone_type_from_base_type(base_type)
        if ztype is None:
            return SGBResult(created=False, reason="UNKNOWN_BASE_TYPE", base_type=base_type or None)

        base_candles = candles[base_start : base_end + 1]

        # Compute bounds if missing or to apply boundary_mode
        ztop, zbot, bounds_meta = _compute_base_bounds_from_candles(
            base_candles,
            mode=cfg.boundary_mode,
            zone_type=ztype,
        )

        # Force ztop/zbot
        ztop, zbot = _normalize_bounds(ztop, zbot)

        proximal, distal = _prox_distal(ztype, ztop, zbot)
        height = ztop - zbot

        # Base scoring (optional)
        base_score = None
        base_grade = None
        score_details: dict[str, Any] = {"enabled": cfg.score_base}

        if cfg.score_base:
            try:
                from app.core.base_engine.base_scorer import BaseScorer
                scorer = BaseScorer()
                score_res = scorer.score(candles, {
                    "base_type": base_type,
                    "base_start_index": base_start,
                    "base_end_index": base_end,
                    "base_top": _normalize_bounds(float(base_top), float(base_bot))[0] if (base_top is not None and base_bot is not None) else max(_c_get(x, "high") for x in base_candles),
                    "base_bot": _normalize_bounds(float(base_top), float(base_bot))[1] if (base_top is not None and base_bot is not None) else min(_c_get(x, "low") for x in base_candles),
                })
                base_score = int(score_res.score)
                base_grade = score_res.grade
                score_details["components"] = score_res.components
                score_details["details"] = score_res.details
            except Exception as exc:
                log.warning("sgb_base_score_failed", error=str(exc))
                score_details["error"] = str(exc)

        # Gate by min score
        if cfg.score_base and base_score is not None and base_score < cfg.min_base_score:
            return SGBResult(
                created=False,
                reason="BASE_SCORE_TOO_LOW",
                zone_type=ztype,
                zone_top=ztop,
                zone_bot=zbot,
                proximal=proximal,
                distal=distal,
                height=height,
                base_type=base_type,
                base_score=base_score,
                base_grade=base_grade,
                base_start_index=base_start,
                base_end_index=base_end,
                created_index=base_end,
                details={
                    "min_base_score": cfg.min_base_score,
                    "boundary": bounds_meta,
                    "base_scoring": score_details,
                },
            )

        return SGBResult(
            created=True,
            reason="OK",
            zone_type=ztype,
            zone_top=float(ztop),
            zone_bot=float(zbot),
            proximal=float(proximal),
            distal=float(distal),
            height=float(height),
            base_type=base_type or None,
            base_score=base_score,
            base_grade=base_grade,
            base_start_index=int(base_start),
            base_end_index=int(base_end),
            created_index=int(base_end),
            details={
                "boundary": bounds_meta,
                "base_scoring": score_details,
                "config": {
                    "boundary_mode": cfg.boundary_mode,
                    "min_base_score": cfg.min_base_score,
                },
            },
        )
