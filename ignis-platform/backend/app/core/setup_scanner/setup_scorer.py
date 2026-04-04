"""
core/setup_scanner/setup_scorer.py — Scoring global d’un setup HLZ (IGNIS)

Rôle :
- Calculer un score global [0..100] à partir d’un résultat d’analyse/pipeline.
- Produire un breakdown clair par composant :
  Base / SDE / SGB / SDP / FTB / PA / Advanced / DP-KL / RR / pénalités

Entrée attendue :
- Un dict d’analyse (typiquement SetupPipelineResult.to_dict()) OU un objet avec attributs similaires.

Le scorer est volontairement :
- Stateless
- Tolérant aux formats (dict / dataclass / pydantic)
- Transparent : retourne components + penalties + reasons
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict, is_dataclass
from typing import Any, Optional

import structlog

from app import SCORING_THRESHOLDS

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers
# ═════════════════════════════════════════════════════════════════════════════=

def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _to_dict(obj: Any) -> dict[str, Any]:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "to_dict") and callable(getattr(obj, "to_dict")):
        try:
            d = obj.to_dict()
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}
    if hasattr(obj, "model_dump") and callable(getattr(obj, "model_dump")):
        try:
            d = obj.model_dump()
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}
    if is_dataclass(obj):
        try:
            return asdict(obj)
        except Exception:
            return dict(getattr(obj, "__dict__", {}) or {})
    return dict(getattr(obj, "__dict__", {}) or {})


def _safe_get(obj: Any, path: list[Any], default: Any = None) -> Any:
    """
    Accès tolérant:
      - dict keys
      - object attributes
      - list indices (int)
    """
    cur = obj
    for k in path:
        if cur is None:
            return default
        if isinstance(k, int):
            if isinstance(cur, list) and 0 <= k < len(cur):
                cur = cur[k]
            else:
                return default
        else:
            if isinstance(cur, dict):
                cur = cur.get(k)
            else:
                cur = getattr(cur, k, None)
    return default if cur is None else cur


def _score_bool(ok: bool, true_score: int = 100, false_score: int = 0) -> int:
    return true_score if ok else false_score


def _rr_score(rr: Optional[float], rr_min: float = 2.0) -> int:
    if rr is None:
        return 0
    try:
        rr = float(rr)
    except Exception:
        return 0
    # HLZ-friendly mapping
    if rr >= 4.0:
        return 100
    if rr >= 3.0:
        return 92
    if rr >= rr_min:
        return 80
    if rr >= 1.5:
        return 55
    return 25


def _touches_score(touches: Optional[int]) -> int:
    if touches is None:
        return 60
    try:
        t = int(touches)
    except Exception:
        return 60
    # 0 touch = fresh ; 1 = FTB taken ; 2+ = weak
    if t <= 0:
        return 100
    if t == 1:
        return 45
    if t == 2:
        return 25
    return 10


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class SetupScorerConfig:
    """
    weights doivent approx somme=1.0
    """
    # Weights
    w_base: float = 0.18
    w_sde: float = 0.14
    w_sgb: float = 0.10
    w_sdp: float = 0.12
    w_ftb: float = 0.10
    w_pa: float = 0.12
    w_advanced: float = 0.08
    w_dp: float = 0.08
    w_rr: float = 0.08

    # Penalties / bonuses (points)
    penalty_flippy: int = 40
    penalty_failed_sde: int = 35
    penalty_zone_exhausted: int = 20
    penalty_weakening_base: int = 15

    bonus_three_drives: int = 8
    bonus_iou: int = 10
    bonus_counter_attack: int = 6
    bonus_golden_ou: int = 6
    bonus_ready_pullback_entry: int = 6

    # Thresholds (mirror global config)
    setup_valid_threshold: int = int(SCORING_THRESHOLDS.get("SETUP_VALID_THRESHOLD", 75))
    rr_min: float = float(SCORING_THRESHOLDS.get("RR_MIN", 2.0))


@dataclass
class SetupScoreBreakdown:
    base: int = 0
    sde: int = 0
    sgb: int = 0
    sdp: int = 0
    ftb: int = 0
    pa: int = 0
    advanced: int = 0
    dp: int = 0
    rr: int = 0

    penalties: int = 0
    bonuses: int = 0

    def to_dict(self) -> dict[str, Any]:
        return _to_dict(self)


@dataclass
class SetupScoreResult:
    score: int = 0
    score01: float = 0.0
    breakdown: SetupScoreBreakdown = field(default_factory=SetupScoreBreakdown)
    reasons: list[str] = field(default_factory=list)
    components_raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "score01": round(self.score01, 4),
            "breakdown": self.breakdown.to_dict(),
            "reasons": list(self.reasons),
            "components_raw": self.components_raw,
        }


# ═════════════════════════════════════════════════════════════════════════════=
# Scorer
# ═════════════════════════════════════════════════════════════════════════════=

class SetupScorer:
    """
    Scorer HLZ global.

    Usage :
        scorer = SetupScorer()
        res = scorer.score(analysis_dict)
    """

    def __init__(self, config: Optional[SetupScorerConfig] = None) -> None:
        self.config = config or SetupScorerConfig()

    def score(self, analysis: Any) -> SetupScoreResult:
        cfg = self.config
        a = analysis  # keep original for safe_get

        # ── Extract components ──────────────────────────────────────────────
        base_score = _safe_get(a, ["base", "base_score", "score"], None)
        if base_score is None:
            base_score = _safe_get(a, ["base", "base_score", "score"], None)  # tolerate duplicate
        try:
            base_score_i = int(base_score) if base_score is not None else 0
        except Exception:
            base_score_i = 0

        sde_score = _safe_get(a, ["sd_zone", "sde", "score"], None)
        if sde_score is None:
            sde_score = _safe_get(a, ["sd_zone", "zone", "sde_score"], None)
        try:
            sde_score_i = int(sde_score) if sde_score is not None else 0
        except Exception:
            sde_score_i = 0

        sgb_created = bool(_safe_get(a, ["sd_zone", "sgb", "created"], False))
        if not sgb_created:
            sgb_created = bool(_safe_get(a, ["sd_zone", "zone", "zone_top"], None) is not None)

        sdp_validated = bool(_safe_get(a, ["sd_zone", "sdp", "sdp_validated"], False)) or (
            str(_safe_get(a, ["sd_zone", "sdp", "status"], "")).upper() == "VALIDATED"
        )
        sdp_strength = _safe_get(a, ["sd_zone", "sdp", "strength"], None)
        try:
            sdp_strength_i = int(sdp_strength) if sdp_strength is not None else (100 if sdp_validated else 0)
        except Exception:
            sdp_strength_i = 100 if sdp_validated else 0

        ftb_valid = bool(_safe_get(a, ["sd_zone", "ftb", "ftb_valid"], False))
        ftb_touches = _safe_get(a, ["sd_zone", "ftb", "touches"], None)
        try:
            ftb_touches_i = int(ftb_touches) if ftb_touches is not None else None
        except Exception:
            ftb_touches_i = None
        ftb_state = str(_safe_get(a, ["sd_zone", "ftb", "ftb_state"], "")).upper()

        flippy_detected = bool(_safe_get(a, ["sd_zone", "flippy", "detected"], False)) or bool(
            _safe_get(a, ["sd_zone", "zone", "is_flippy"], False)
        )
        failed_sde = bool(_safe_get(a, ["sd_zone", "failed_sde", "failed"], False))

        weakening = bool(_safe_get(a, ["base", "weakening_base", "weakened"], False))
        exhausted = ftb_state == "EXHAUSTED" or (ftb_touches_i is not None and ftb_touches_i >= 2)

        # PA best
        pa_best = _safe_get(a, ["pa", "best"], {}) or {}
        pa_strength = pa_best.get("strength", pa_best.get("score", 0))
        try:
            pa_strength_i = int(pa_strength) if pa_strength is not None else 0
        except Exception:
            pa_strength_i = 0
        pa_name = str(pa_best.get("pattern") or pa_best.get("pa_pattern") or pa_best.get("type") or "").upper()

        # Advanced best
        adv_best = _safe_get(a, ["advanced", "best"], {}) or {}
        adv_strength = adv_best.get("strength", adv_best.get("score", 0))
        try:
            adv_strength_i = int(adv_strength) if adv_strength is not None else 0
        except Exception:
            adv_strength_i = 0
        adv_name = str(adv_best.get("pattern") or adv_best.get("type") or "").upper()

        # DP best
        best_dp = _safe_get(a, ["decision_points", "best_dp"], {}) or {}
        dp_strength = best_dp.get("strength", best_dp.get("score", 0))
        try:
            dp_strength_i = int(dp_strength) if dp_strength is not None else 0
        except Exception:
            dp_strength_i = 0

        # SLTP / RR
        rr = _safe_get(a, ["sl_tp", "rr"], None)
        rr_ok = bool(_safe_get(a, ["sl_tp", "rr_ok"], False))
        rr_score_i = _rr_score(rr, rr_min=cfg.rr_min)

        # Pullback entry bonus
        pe_state = str(_safe_get(a, ["pullback_entry", "state"], "")).upper()
        pe_detected = bool(_safe_get(a, ["pullback_entry", "detected"], False))
        pe_ready = pe_detected and pe_state == "READY"

        # ── Build per-component normalized scores [0..100] ──────────────────
        base_comp = max(0, min(100, base_score_i))
        sde_comp = max(0, min(100, sde_score_i))
        sgb_comp = _score_bool(sgb_created, 100, 0)
        sdp_comp = max(0, min(100, sdp_strength_i))
        ftb_comp = 100 if ftb_valid else _touches_score(ftb_touches_i)
        pa_comp = max(0, min(100, pa_strength_i))
        adv_comp = max(0, min(100, adv_strength_i))
        dp_comp = max(0, min(100, dp_strength_i))
        rr_comp = rr_score_i

        breakdown = SetupScoreBreakdown(
            base=base_comp,
            sde=sde_comp,
            sgb=sgb_comp,
            sdp=sdp_comp,
            ftb=ftb_comp,
            pa=pa_comp,
            advanced=adv_comp,
            dp=dp_comp,
            rr=rr_comp,
        )

        # ── Weighted sum (0..1) ─────────────────────────────────────────────
        score01 = (
            cfg.w_base * (breakdown.base / 100)
            + cfg.w_sde * (breakdown.sde / 100)
            + cfg.w_sgb * (breakdown.sgb / 100)
            + cfg.w_sdp * (breakdown.sdp / 100)
            + cfg.w_ftb * (breakdown.ftb / 100)
            + cfg.w_pa * (breakdown.pa / 100)
            + cfg.w_advanced * (breakdown.advanced / 100)
            + cfg.w_dp * (breakdown.dp / 100)
            + cfg.w_rr * (breakdown.rr / 100)
        )
        score = int(round(100 * _clip01(score01)))

        reasons: list[str] = []

        # ── Penalties ───────────────────────────────────────────────────────
        penalties = 0
        if flippy_detected:
            penalties += cfg.penalty_flippy
            reasons.append("Pénalité: FLIPPY détecté")
        if failed_sde:
            penalties += cfg.penalty_failed_sde
            reasons.append("Pénalité: Failed SDE")
        if exhausted:
            penalties += cfg.penalty_zone_exhausted
            reasons.append("Pénalité: Zone trop touchée / EXHAUSTED")
        if weakening:
            penalties += cfg.penalty_weakening_base
            reasons.append("Pénalité: Weakening Base")

        # ── Bonuses ─────────────────────────────────────────────────────────
        bonuses = 0
        if "THREE" in pa_name or "3" in pa_name:
            bonuses += cfg.bonus_three_drives
            reasons.append("Bonus: Three Drives")
        if adv_name == "IOU" or "IOU" in adv_name:
            bonuses += cfg.bonus_iou
            reasons.append("Bonus: IOU")
        if adv_name == "COUNTER_ATTACK" or "COUNTER" in adv_name:
            bonuses += cfg.bonus_counter_attack
            reasons.append("Bonus: Counter Attack")
        if adv_name == "OVER_UNDER" and bool(adv_best.get("golden_zone", False)):
            bonuses += cfg.bonus_golden_ou
            reasons.append("Bonus: Over&Under Golden Zone")
        if pe_ready:
            bonuses += cfg.bonus_ready_pullback_entry
            reasons.append("Bonus: Pullback Entry READY")

        breakdown.penalties = penalties
        breakdown.bonuses = bonuses

        final = max(0, min(100, score - penalties + bonuses))
        final01 = final / 100.0

        # ── Auto reasons (missing critical components) ──────────────────────
        if not sgb_created:
            reasons.append("Info: SGB non confirmé")
        if sde_score_i <= 0:
            reasons.append("Info: SDE non détecté / score manquant")
        if not sdp_validated:
            reasons.append("Info: SDP non validé (HEAD pas tenu)")
        if not rr_ok:
            reasons.append("Info: RR minimum non atteint (ou SL/TP absent)")

        return SetupScoreResult(
            score=int(final),
            score01=float(round(final01, 4)),
            breakdown=breakdown,
            reasons=reasons,
            components_raw={
                "base_score": base_score_i,
                "sde_score": sde_score_i,
                "sgb_created": sgb_created,
                "sdp_validated": sdp_validated,
                "sdp_strength": sdp_strength_i,
                "ftb_valid": ftb_valid,
                "ftb_state": ftb_state,
                "ftb_touches": ftb_touches_i,
                "flippy_detected": flippy_detected,
                "failed_sde": failed_sde,
                "weakening_base": weakening,
                "pa_best": pa_best,
                "advanced_best": adv_best,
                "best_dp": best_dp,
                "rr": rr,
                "rr_ok": rr_ok,
                "pullback_entry_state": pe_state,
            },
        )
