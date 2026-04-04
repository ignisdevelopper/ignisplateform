"""
core/base_engine/base_detector.py — Détection des bases HLZ (RBR/DBD/RBD/DBR)

Objectif :
- Détecter automatiquement une "base" (consolidation / pause) encadrée par des impulsions.
- Classifier le schéma :
    RBR = Rally-Base-Rally
    DBD = Drop-Base-Drop
    RBD = Rally-Base-Drop
    DBR = Drop-Base-Rally

Approche (heuristique robuste) :
1) Scanner les N dernières bougies (lookback).
2) Trouver des segments "base" (min_base_candles..max_base_candles) :
   - ranges (high-low) faibles vs ATR
   - overlap élevé (compression)
   - corps (|close-open|) modestes
3) Vérifier impulsion AVANT et APRÈS la base :
   - mouvement net >= X*ATR
   - majorité de bougies directionnelles dans le bon sens
4) Déduire le BaseType à partir (dir_pre, dir_post).
5) Retourner le meilleur candidat (score le plus haut), ou la liste.

Design :
- Stateless
- Tolérant : candles dict ou objets (open/high/low/close)
- Ne dépend pas de pandas/numpy (facile à tester)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

from app import BaseType

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Candle helpers (tolérant)
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


def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _body(c: Any) -> float:
    return abs(_c_get(c, "close") - _c_get(c, "open"))


def _range(c: Any) -> float:
    return max(0.0, _c_get(c, "high") - _c_get(c, "low"))


def _is_bull(c: Any) -> bool:
    return _c_get(c, "close") > _c_get(c, "open")


def _is_bear(c: Any) -> bool:
    return _c_get(c, "close") < _c_get(c, "open")


def _compute_atr(candles: list[Any], period: int = 14) -> float:
    """
    ATR simple basé sur True Range moyen.
    """
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


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class BaseDetectorConfig:
    # Fenêtre de scan
    lookback: int = 220

    # ATR normalisation
    atr_period: int = 14

    # Base segment length
    min_base_candles: int = 2
    max_base_candles: int = 8

    # Impulsions avant/après base
    pre_impulse_candles: int = 4
    post_impulse_candles: int = 4

    # Qualité de la base (tightness)
    max_base_height_atr_mult: float = 1.10     # (base_high-base_low) <= X*ATR
    max_avg_candle_range_atr_mult: float = 0.65
    max_avg_body_to_range: float = 0.45        # base = corps plutôt modestes
    min_overlap_ratio: float = 0.55            # compressions -> overlaps

    # Qualité impulsion
    min_impulse_net_atr_mult: float = 1.20     # net move sur pre/post >= X*ATR
    min_impulse_directional_pct: float = 0.60  # % bougies dans le sens
    min_impulse_avg_range_atr_mult: float = 0.85  # ranges moyens impulsion >= X*ATR

    # Scoring (0..1)
    w_base_tightness: float = 0.45
    w_overlap: float = 0.20
    w_pre_impulse: float = 0.15
    w_post_impulse: float = 0.20

    # Choix du meilleur candidat
    prefer_most_recent: bool = True


@dataclass
class BaseDetectionResult:
    detected: bool = False
    base_type: Optional[str] = None          # BaseType.* (string)
    pre_direction: str = ""                  # "BULLISH" | "BEARISH"
    post_direction: str = ""                 # "BULLISH" | "BEARISH"
    strength: int = 0                        # 0..100

    # Indices dans la série complète passée à detect()
    base_start_index: Optional[int] = None
    base_end_index: Optional[int] = None
    pre_start_index: Optional[int] = None
    pre_end_index: Optional[int] = None
    post_start_index: Optional[int] = None
    post_end_index: Optional[int] = None

    # Niveaux base
    base_top: Optional[float] = None
    base_bot: Optional[float] = None
    base_height: Optional[float] = None

    atr: Optional[float] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class BaseDetector:
    """
    Détecte une base HLZ et la classe (RBR/DBD/RBD/DBR).

    API :
        detector = BaseDetector()
        res = detector.detect(candles)
        all_res = detector.detect_all(candles)
    """

    def __init__(self, config: Optional[BaseDetectorConfig] = None) -> None:
        self.config = config or BaseDetectorConfig()

    def detect(self, candles: list[Any]) -> BaseDetectionResult:
        """
        Retourne le meilleur candidat (ou detected=False).
        """
        results = self.detect_all(candles)
        if not results:
            return BaseDetectionResult(detected=False, details={"reason": "no_candidate"})
        # best déjà trié
        return results[0]

    def detect_all(self, candles: list[Any]) -> list[BaseDetectionResult]:
        """
        Retourne tous les candidats valides, triés par score décroissant
        (puis récence si prefer_most_recent).
        """
        cfg = self.config

        if not candles or len(candles) < (cfg.atr_period + cfg.pre_impulse_candles + cfg.max_base_candles + cfg.post_impulse_candles + 5):
            return []

        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        base_offset = lb_start

        atr = _compute_atr(c, period=cfg.atr_period)
        if atr <= 0:
            return []

        candidates: list[BaseDetectionResult] = []

        # On choisit des bases dont on peut vérifier pre+post
        min_i = cfg.pre_impulse_candles
        max_i = len(c) - cfg.post_impulse_candles - cfg.min_base_candles - 1
        if max_i <= min_i:
            return []

        for base_start in range(min_i, max_i + 1):
            for base_len in range(cfg.min_base_candles, cfg.max_base_candles + 1):
                base_end = base_start + base_len - 1
                if base_end >= len(c) - cfg.post_impulse_candles:
                    continue

                pre_start = base_start - cfg.pre_impulse_candles
                pre_end = base_start - 1
                post_start = base_end + 1
                post_end = base_end + cfg.post_impulse_candles

                base_win = c[base_start : base_end + 1]
                pre_win = c[pre_start : pre_end + 1]
                post_win = c[post_start : post_end + 1]

                base_ok, base_meta = _check_base_segment(base_win, atr, cfg)
                if not base_ok:
                    continue

                pre_ok, pre_dir, pre_meta = _check_impulse(pre_win, atr, cfg)
                if not pre_ok:
                    continue

                post_ok, post_dir, post_meta = _check_impulse(post_win, atr, cfg)
                if not post_ok:
                    continue

                base_type = _classify_base(pre_dir, post_dir)
                if base_type is None:
                    continue

                # score
                score01 = (
                    cfg.w_base_tightness * base_meta["tightness_score01"]
                    + cfg.w_overlap * base_meta["overlap_score01"]
                    + cfg.w_pre_impulse * pre_meta["impulse_score01"]
                    + cfg.w_post_impulse * post_meta["impulse_score01"]
                )
                strength = int(round(100 * _clip01(score01)))

                # base levels
                b_top = base_meta["base_top"]
                b_bot = base_meta["base_bot"]
                b_h = b_top - b_bot

                candidates.append(BaseDetectionResult(
                    detected=True,
                    base_type=base_type,
                    pre_direction=pre_dir,
                    post_direction=post_dir,
                    strength=strength,
                    base_start_index=base_offset + base_start,
                    base_end_index=base_offset + base_end,
                    pre_start_index=base_offset + pre_start,
                    pre_end_index=base_offset + pre_end,
                    post_start_index=base_offset + post_start,
                    post_end_index=base_offset + post_end,
                    base_top=float(b_top),
                    base_bot=float(b_bot),
                    base_height=float(b_h),
                    atr=float(atr),
                    details={
                        "scores": {
                            "tightness": round(base_meta["tightness_score01"], 3),
                            "overlap": round(base_meta["overlap_score01"], 3),
                            "pre_impulse": round(pre_meta["impulse_score01"], 3),
                            "post_impulse": round(post_meta["impulse_score01"], 3),
                            "total01": round(_clip01(score01), 3),
                        },
                        "base": base_meta,
                        "pre_impulse": pre_meta,
                        "post_impulse": post_meta,
                    },
                ))

        if not candidates:
            return []

        # Trier : score desc, puis récence si demandé
        if cfg.prefer_most_recent:
            candidates.sort(
                key=lambda r: (r.strength, r.base_end_index or -1),
                reverse=True,
            )
        else:
            candidates.sort(key=lambda r: r.strength, reverse=True)

        return candidates


# ═════════════════════════════════════════════════════════════════════════════=
# Internals
# ═════════════════════════════════════════════════════════════════════════════=

def _classify_base(pre_dir: str, post_dir: str) -> Optional[str]:
    if pre_dir == "BULLISH" and post_dir == "BULLISH":
        return BaseType.RBR
    if pre_dir == "BEARISH" and post_dir == "BEARISH":
        return BaseType.DBD
    if pre_dir == "BULLISH" and post_dir == "BEARISH":
        return BaseType.RBD
    if pre_dir == "BEARISH" and post_dir == "BULLISH":
        return BaseType.DBR
    return None


def _overlap_ratio(candles: list[Any]) -> float:
    """
    Overlap: proportion de bougies dont le range chevauche le range précédent.
    """
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
    return overlaps / max(1, (len(candles) - 1))


def _check_base_segment(
    base_win: list[Any],
    atr: float,
    cfg: BaseDetectorConfig,
) -> tuple[bool, dict[str, Any]]:
    """
    Base = consolidation serrée :
    - height <= X*ATR
    - avg range <= Y*ATR
    - avg body/range <= Z
    - overlap ratio >= threshold
    """
    if not base_win or atr <= 0:
        return False, {"reason": "invalid_input"}

    highs = [_c_get(x, "high") for x in base_win]
    lows = [_c_get(x, "low") for x in base_win]
    base_top = max(highs)
    base_bot = min(lows)
    height = base_top - base_bot
    if height <= 0:
        return False, {"reason": "height_invalid"}

    avg_rng = sum(_range(x) for x in base_win) / len(base_win)
    avg_body = sum(_body(x) for x in base_win) / len(base_win)
    avg_body_to_range = avg_body / max(1e-12, avg_rng)

    ov = _overlap_ratio(base_win)

    if height > cfg.max_base_height_atr_mult * atr:
        return False, {"reason": "base_too_tall", "height": height, "atr": atr}
    if avg_rng > cfg.max_avg_candle_range_atr_mult * atr:
        return False, {"reason": "base_ranges_too_large", "avg_range": avg_rng, "atr": atr}
    if avg_body_to_range > cfg.max_avg_body_to_range:
        return False, {"reason": "base_bodies_too_large", "avg_body_to_range": avg_body_to_range}
    if ov < cfg.min_overlap_ratio:
        return False, {"reason": "overlap_too_low", "overlap": ov}

    # Tightness score: plus height/avg_rng sont petits, mieux c'est.
    height_score = _clip01(1.0 - (height / (cfg.max_base_height_atr_mult * atr)))
    rng_score = _clip01(1.0 - (avg_rng / (cfg.max_avg_candle_range_atr_mult * atr)))
    body_score = _clip01(1.0 - (avg_body_to_range / max(1e-9, cfg.max_avg_body_to_range)))
    tightness_score01 = _clip01(0.45 * height_score + 0.35 * rng_score + 0.20 * body_score)

    overlap_score01 = _clip01((ov - cfg.min_overlap_ratio) / max(1e-9, (1.0 - cfg.min_overlap_ratio)))

    return True, {
        "base_top": base_top,
        "base_bot": base_bot,
        "base_height": height,
        "avg_range": avg_rng,
        "avg_body": avg_body,
        "avg_body_to_range": round(avg_body_to_range, 4),
        "overlap_ratio": round(ov, 3),
        "tightness_score01": round(tightness_score01, 3),
        "overlap_score01": round(overlap_score01, 3),
    }


def _check_impulse(
    win: list[Any],
    atr: float,
    cfg: BaseDetectorConfig,
) -> tuple[bool, str, dict[str, Any]]:
    """
    Impulse = mouvement directionnel net + ranges plus larges, sur une fenêtre courte.
    """
    if not win or atr <= 0:
        return False, "", {"reason": "invalid_input"}

    bulls = sum(1 for x in win if _is_bull(x))
    bears = sum(1 for x in win if _is_bear(x))
    frac_bull = bulls / len(win)
    frac_bear = bears / len(win)

    o0 = _c_get(win[0], "open")
    cN = _c_get(win[-1], "close")

    # direction par net move + majorité
    if cN > o0 and frac_bull >= cfg.min_impulse_directional_pct:
        direction = "BULLISH"
        net = cN - o0
        frac = frac_bull
    elif cN < o0 and frac_bear >= cfg.min_impulse_directional_pct:
        direction = "BEARISH"
        net = o0 - cN
        frac = frac_bear
    else:
        return False, "", {
            "reason": "not_directional_enough",
            "frac_bull": round(frac_bull, 3),
            "frac_bear": round(frac_bear, 3),
            "o0": o0,
            "cN": cN,
        }

    if net < cfg.min_impulse_net_atr_mult * atr:
        return False, "", {
            "reason": "net_move_too_small",
            "direction": direction,
            "net": net,
            "min_required": cfg.min_impulse_net_atr_mult * atr,
            "atr": atr,
        }

    avg_rng = sum(_range(x) for x in win) / len(win)
    if avg_rng < cfg.min_impulse_avg_range_atr_mult * atr:
        return False, "", {
            "reason": "impulse_ranges_too_small",
            "avg_range": avg_rng,
            "min_required": cfg.min_impulse_avg_range_atr_mult * atr,
            "atr": atr,
        }

    # impulse score: combine fraction + amplitude + range
    frac_score = _clip01((frac - cfg.min_impulse_directional_pct) / max(1e-9, (1.0 - cfg.min_impulse_directional_pct)))
    amp_score = _clip01(net / max(1e-9, (cfg.min_impulse_net_atr_mult * atr)) - 1.0)
    rng_score = _clip01(avg_rng / max(1e-9, (cfg.min_impulse_avg_range_atr_mult * atr)) - 1.0)

    impulse_score01 = _clip01(0.45 * frac_score + 0.35 * amp_score + 0.20 * rng_score)

    return True, direction, {
        "direction": direction,
        "net_move": net,
        "atr": atr,
        "frac_directional": round(frac, 3),
        "avg_range": avg_rng,
        "impulse_score01": round(impulse_score01, 3),
    }
