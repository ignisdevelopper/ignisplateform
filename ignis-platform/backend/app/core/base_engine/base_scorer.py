"""
core/base_engine/base_scorer.py — Scoring de solidité d'une base HLZ (0..100)

Rôle :
- Prendre une base détectée (RBR/DBD/RBD/DBR + indices + top/bot)
- Donner un score de "solidité" de la base (qualité structurelle + départ + fraîcheur)

Ce scoring est conçu pour être :
- Stateless
- Tolérant aux formats (base dict/obj, candles dict/obj)
- Exploitable par le setup_scanner pour filtrer les SGB faibles

Heuristiques principales (robustes & génériques) :
1) Tightness : hauteur de base faible vs ATR
2) Compression : overlap des ranges + corps modérés (pas trop de bougies impulsives dans la base)
3) Departure : impulsion de sortie (net move) dans le sens du BaseType
4) Freshness : base récente (pas "trop vieille")
5) Touches : nombre de retours/overlaps après départ (proxy weakening)

NB :
- Le module "weakening_base.py" peut aller plus loin ; ici on fournit un score global simple
  + des sous-scores explicites.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

from app import BaseType

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Candle / Base helpers (tolérant)
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


def _overlap_ratio(candles: list[Any]) -> float:
    """% de bougies dont le range chevauche le range précédent."""
    if len(candles) < 2:
        return 0.0
    overlaps = 0
    for i in range(1, len(candles)):
        a = candles[i - 1]
        b = candles[i]
        a_hi, a_lo = _c_get(a, "high"), _c_get(a, "low")
        b_hi, b_lo = _c_get(b, "high"), _c_get(b, "low")
        if not (b_hi < a_lo or b_lo > a_hi):
            overlaps += 1
    return overlaps / max(1, len(candles) - 1)


def _intersects(high: float, low: float, top: float, bot: float) -> bool:
    return not (high < bot or low > top)


def _departure_direction(base_type: str) -> str:
    """
    Direction du move après base :
      - RBR, DBR => bullish departure
      - DBD, RBD => bearish departure
    """
    bt = (base_type or "").upper()
    if bt in (BaseType.RBR, BaseType.DBR):
        return "BULLISH"
    if bt in (BaseType.DBD, BaseType.RBD):
        return "BEARISH"
    # fallback
    return ""


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class BaseScorerConfig:
    # ATR
    atr_period: int = 14

    # Tightness normalization
    max_base_height_atr_mult: float = 1.10  # base height >= X*ATR => score tend vers 0

    # Departure evaluation
    departure_lookahead: int = 6           # nb bougies après base_end à analyser
    min_departure_atr_mult: float = 1.20   # net move minimal "bon départ" (en ATR)

    # Freshness / Age
    max_age_bars: int = 220                # au-delà => score freshness 0

    # Touches (proxy weakening)
    touches_lookahead: int = 250           # nb bougies post-base à scanner pour retours
    ignore_first_bars_after_base: int = 2  # ignore les 1-2 premières bougies de départ
    max_touches: int = 3                   # >= max_touches => touch_score tend vers 0

    # Base candle quality
    max_avg_body_to_range: float = 0.50    # base trop "impulsive" si body/range trop haut
    min_overlap_ratio: float = 0.55

    # Wickiness (base doit être plutôt "propre")
    max_avg_wick_to_range: float = 0.75

    # Weights (0..1)
    w_tightness: float = 0.30
    w_compression: float = 0.20
    w_candle_quality: float = 0.15
    w_departure: float = 0.20
    w_freshness: float = 0.10
    w_touches: float = 0.05


@dataclass
class BaseScoreResult:
    base_type: Optional[str] = None
    score: int = 0               # 0..100
    grade: str = ""              # "A"|"B"|"C"|"D"
    atr: Optional[float] = None

    base_start_index: Optional[int] = None
    base_end_index: Optional[int] = None
    base_top: Optional[float] = None
    base_bot: Optional[float] = None
    base_height: Optional[float] = None

    departure_direction: str = ""
    departure_net_move: Optional[float] = None
    touches: int = 0
    age_bars: int = 0

    components: dict[str, Any] = field(default_factory=dict)
    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Scorer
# ═════════════════════════════════════════════════════════════════════════════=

class BaseScorer:
    """
    Score la solidité d'une base.

    Entrée base attendue :
    - base_type (str) : RBR/DBD/RBD/DBR
    - base_start_index, base_end_index (int)
    - base_top, base_bot (float)

    Compatible avec BaseDetectionResult (base_detector.py) ou dict équivalent.
    """

    def __init__(self, config: Optional[BaseScorerConfig] = None) -> None:
        self.config = config or BaseScorerConfig()

    def score(self, candles: list[Any], base: Any) -> BaseScoreResult:
        cfg = self.config

        if not candles or len(candles) < cfg.atr_period + 10:
            return BaseScoreResult(score=0, grade="D", details={"reason": "not_enough_candles"})

        base_type = _b_get(base, "base_type", "") or _b_get(base, "type", "")
        b_start = _b_get(base, "base_start_index")
        b_end = _b_get(base, "base_end_index")
        b_top = _b_get(base, "base_top")
        b_bot = _b_get(base, "base_bot")

        if b_start is None or b_end is None or b_top is None or b_bot is None:
            return BaseScoreResult(
                base_type=str(base_type) if base_type else None,
                score=0,
                grade="D",
                details={"reason": "base_missing_fields"},
            )

        b_start = int(b_start)
        b_end = int(b_end)
        b_top = float(b_top)
        b_bot = float(b_bot)
        if b_top < b_bot:
            b_top, b_bot = b_bot, b_top

        if b_start < 0 or b_end >= len(candles) or b_end <= b_start:
            return BaseScoreResult(
                base_type=str(base_type) if base_type else None,
                score=0,
                grade="D",
                details={"reason": "base_indices_invalid", "b_start": b_start, "b_end": b_end},
            )

        # ATR calc: on privilégie un contexte récent (dernières bougies) mais stable
        atr = _compute_atr(candles, period=cfg.atr_period)
        if atr <= 0:
            return BaseScoreResult(
                base_type=str(base_type) if base_type else None,
                score=0,
                grade="D",
                details={"reason": "atr_invalid"},
            )

        base_win = candles[b_start : b_end + 1]
        height = b_top - b_bot

        # ── 1) Tightness score ────────────────────────────────────────────────
        # height <= max_height_atr_mult*atr => bon
        tightness_score = _clip01(1.0 - (height / max(1e-9, cfg.max_base_height_atr_mult * atr)))

        # ── 2) Compression score (overlap) ────────────────────────────────────
        ov = _overlap_ratio(base_win)
        compression_score = _clip01((ov - cfg.min_overlap_ratio) / max(1e-9, (1.0 - cfg.min_overlap_ratio)))

        # ── 3) Candle quality score (body/range + wickiness) ─────────────────
        ranges = [_range(x) for x in base_win]
        bodies = [_body(x) for x in base_win]
        avg_rng = (sum(ranges) / len(ranges)) if ranges else 0.0
        avg_body = (sum(bodies) / len(bodies)) if bodies else 0.0
        avg_body_to_range = avg_body / max(1e-12, avg_rng)

        wicks = [(_upper_wick(x) + _lower_wick(x)) for x in base_win]
        avg_wick_to_range = (sum(wicks) / len(wicks)) / max(1e-12, avg_rng) if wicks else 1.0

        body_score = _clip01(1.0 - (avg_body_to_range / max(1e-9, cfg.max_avg_body_to_range)))
        wick_score = _clip01(1.0 - (avg_wick_to_range / max(1e-9, cfg.max_avg_wick_to_range)))
        candle_quality_score = _clip01(0.55 * body_score + 0.45 * wick_score)

        # ── 4) Departure score ───────────────────────────────────────────────
        dep_dir = _departure_direction(str(base_type))
        dep_start = b_end + 1
        dep_end = min(len(candles) - 1, dep_start + cfg.departure_lookahead - 1)

        departure_score = 0.0
        departure_net = 0.0
        departure_meta: dict[str, Any] = {}

        if dep_dir and dep_start <= dep_end:
            dep_win = candles[dep_start : dep_end + 1]
            if dep_dir == "BULLISH":
                # net move depuis base_top vers un max high
                max_high = max(_c_get(x, "high") for x in dep_win)
                departure_net = max(0.0, max_high - b_top)
            else:
                min_low = min(_c_get(x, "low") for x in dep_win)
                departure_net = max(0.0, b_bot - min_low)

            min_required = cfg.min_departure_atr_mult * atr
            # score: 1 quand departure_net ~ >= min_required + 1 ATR (cap)
            departure_score = _clip01(departure_net / max(1e-9, min_required))
            departure_meta = {
                "departure_direction": dep_dir,
                "departure_net": departure_net,
                "min_required": min_required,
                "departure_net_atr": round(departure_net / atr, 3) if atr > 0 else None,
                "lookahead": cfg.departure_lookahead,
            }

        # ── 5) Freshness score (age) ─────────────────────────────────────────
        age_bars = max(0, (len(candles) - 1) - b_end)
        freshness_score = _clip01(1.0 - (age_bars / max(1, cfg.max_age_bars)))

        # ── 6) Touches score (retours sur base) ──────────────────────────────
        t_start = min(len(candles) - 1, b_end + 1 + cfg.ignore_first_bars_after_base)
        t_end = min(len(candles) - 1, b_end + cfg.touches_lookahead)

        touches = 0
        if t_start <= t_end:
            # On compte les "touches" comme nombre de bougies distinctes qui intersectent la base
            # avec déduplication simple (séquences contiguës => 1 touch)
            in_touch = False
            for i in range(t_start, t_end + 1):
                hi = _c_get(candles[i], "high")
                lo = _c_get(candles[i], "low")
                hit = _intersects(hi, lo, b_top, b_bot)
                if hit and not in_touch:
                    touches += 1
                    in_touch = True
                elif not hit:
                    in_touch = False

        touches_score = _clip01(1.0 - (touches / max(1, cfg.max_touches)))

        # ── Score final ──────────────────────────────────────────────────────
        score01 = (
            cfg.w_tightness * tightness_score
            + cfg.w_compression * compression_score
            + cfg.w_candle_quality * candle_quality_score
            + cfg.w_departure * departure_score
            + cfg.w_freshness * freshness_score
            + cfg.w_touches * touches_score
        )
        score = int(round(100 * _clip01(score01)))

        grade = "D"
        if score >= 85:
            grade = "A"
        elif score >= 70:
            grade = "B"
        elif score >= 55:
            grade = "C"

        return BaseScoreResult(
            base_type=str(base_type) if base_type else None,
            score=score,
            grade=grade,
            atr=float(atr),

            base_start_index=b_start,
            base_end_index=b_end,
            base_top=b_top,
            base_bot=b_bot,
            base_height=float(height),

            departure_direction=dep_dir,
            departure_net_move=float(departure_net) if departure_net is not None else None,
            touches=touches,
            age_bars=age_bars,

            components={
                "tightness": round(tightness_score, 3),
                "compression": round(compression_score, 3),
                "candle_quality": round(candle_quality_score, 3),
                "departure": round(departure_score, 3),
                "freshness": round(freshness_score, 3),
                "touches": round(touches_score, 3),
                "total01": round(_clip01(score01), 3),
            },
            details={
                "base_stats": {
                    "overlap_ratio": round(ov, 3),
                    "avg_range": avg_rng,
                    "avg_body": avg_body,
                    "avg_body_to_range": round(avg_body_to_range, 4),
                    "avg_wick_to_range": round(avg_wick_to_range, 4),
                    "height": height,
                    "height_atr": round(height / atr, 3) if atr > 0 else None,
                },
                "departure": departure_meta,
                "touches": {
                    "touches": touches,
                    "touch_scan_start": t_start,
                    "touch_scan_end": t_end,
                    "max_touches": cfg.max_touches,
                },
            },
        )

    def score_many(self, candles: list[Any], bases: list[Any]) -> list[BaseScoreResult]:
        return [self.score(candles, b) for b in bases]
