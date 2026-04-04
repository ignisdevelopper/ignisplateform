"""
core/setup_scanner/setup_validator.py — Validation HLZ des setups (IGNIS)

Rôle :
- Déterminer le statut du setup : VALID / PENDING / INVALID / WATCH / EXPIRED
- Produire une checklist lisible (SB, SDE, SGB, SDP, FTB, PA, DP/KL, RR, etc.)
- Expliquer la raison principale (reason + pending_step)

Entrée :
- analysis dict (typiquement SetupPipelineResult.to_dict())

Design :
- Stateless
- Tolérant (dict/dataclass/pydantic)
- N'impose pas un format strict : il lit plusieurs chemins possibles.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict, is_dataclass
from typing import Any, Optional

import structlog

from app import SCORING_THRESHOLDS, SetupStatus

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers
# ═════════════════════════════════════════════════════════════════════════════=

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


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    if isinstance(v, (int, float)):
        return v != 0
    s = str(v).strip().lower()
    return s in ("true", "1", "yes", "y", "ok", "validated", "valid")


def _as_int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except Exception:
        return default


def _as_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except Exception:
        return default


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class SetupValidatorConfig:
    # Thresholds
    base_solid_min: int = int(SCORING_THRESHOLDS.get("BASE_SOLID_MIN", 70))
    setup_valid_threshold: int = int(SCORING_THRESHOLDS.get("SETUP_VALID_THRESHOLD", 75))
    rr_min: float = float(SCORING_THRESHOLDS.get("RR_MIN", 2.0))

    # Strictness flags
    require_sb: bool = True
    require_pa: bool = False           # HLZ: PA est très fort mais parfois optionnel selon ton style
    require_dp: bool = True
    require_rr: bool = True
    require_sdp: bool = False          # certains styles valident sans SDP explicite (à toi d’activer)

    # FTB policy
    invalidate_if_ftb_taken: bool = True   # spec: FTB déjà pris => INVALID

    # Flippy policy
    invalidate_if_flippy: bool = True      # spec: setup venant d’un FLIPPY => INVALID


@dataclass
class SetupValidationResult:
    status: str = SetupStatus.WATCH
    is_valid: bool = False
    is_pending: bool = False
    is_invalid: bool = False
    is_expired: bool = False

    reason: str = ""
    pending_step: str = ""

    checklist: dict[str, bool] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    blocks: list[str] = field(default_factory=list)  # raisons bloquantes

    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "is_valid": self.is_valid,
            "is_pending": self.is_pending,
            "is_invalid": self.is_invalid,
            "is_expired": self.is_expired,
            "reason": self.reason,
            "pending_step": self.pending_step,
            "checklist": dict(self.checklist),
            "warnings": list(self.warnings),
            "blocks": list(self.blocks),
            "details": self.details,
        }


# ═════════════════════════════════════════════════════════════════════════════=
# Validator
# ═════════════════════════════════════════════════════════════════════════════=

class SetupValidator:
    """
    Validator HLZ.

    Utilisation :
        v = SetupValidator()
        out = v.validate(analysis_dict)
    """

    def __init__(self, config: Optional[SetupValidatorConfig] = None) -> None:
        self.config = config or SetupValidatorConfig()

    def validate(self, analysis: Any) -> SetupValidationResult:
        cfg = self.config
        a = analysis

        # ── Extract common blocks ────────────────────────────────────────────
        base_score = _safe_get(a, ["base", "base_score", "score"], None)
        base_score_i = _as_int(base_score, 0)

        sde_detected = _as_bool(_safe_get(a, ["sd_zone", "sde", "detected"], False)) or _as_bool(
            _safe_get(a, ["sd_zone", "zone", "sde_detected"], False)
        )
        sde_score = _safe_get(a, ["sd_zone", "sde", "score"], None)
        sde_score_i = _as_int(sde_score, 0)

        sgb_created = _as_bool(_safe_get(a, ["sd_zone", "sgb", "created"], False)) or (
            _safe_get(a, ["sd_zone", "zone", "zone_top"], None) is not None
            and _safe_get(a, ["sd_zone", "zone", "zone_bot"], None) is not None
        )

        sdp_status = str(_safe_get(a, ["sd_zone", "sdp", "status"], "")).upper()
        sdp_validated = _as_bool(_safe_get(a, ["sd_zone", "sdp", "sdp_validated"], False)) or (sdp_status == "VALIDATED")

        ftb_valid = _as_bool(_safe_get(a, ["sd_zone", "ftb", "ftb_valid"], False))
        ftb_state = str(_safe_get(a, ["sd_zone", "ftb", "ftb_state"], "")).upper()
        ftb_touches = _safe_get(a, ["sd_zone", "ftb", "touches"], None)
        ftb_touches_i = None if ftb_touches is None else _as_int(ftb_touches, 0)
        ftb_taken = _as_bool(_safe_get(a, ["sd_zone", "ftb", "ftb_taken"], False)) or (
            ftb_touches_i is not None and ftb_touches_i >= 1
        )

        flippy_detected = _as_bool(_safe_get(a, ["sd_zone", "flippy", "detected"], False)) or _as_bool(
            _safe_get(a, ["sd_zone", "zone", "is_flippy"], False)
        )

        failed_sde_failed = _as_bool(_safe_get(a, ["sd_zone", "failed_sde", "failed"], False))
        failed_sde_reason = str(_safe_get(a, ["sd_zone", "failed_sde", "reason"], "")).upper()

        # Market structure / SB
        sb_detected = _as_bool(_safe_get(a, ["market_structure", "structure_break", "detected"], False))
        sb_level = _safe_get(a, ["market_structure", "structure_break", "broken_level"], None)
        sb_ok = sb_detected and (sb_level is not None)

        # PA best
        pa_best = _safe_get(a, ["pa", "best"], {}) or {}
        pa_detected = _as_bool(pa_best.get("detected", True)) and (pa_best.get("strength", 0) or 0) > 0
        pa_strength = _as_int(pa_best.get("strength", 0), 0)

        # DP best
        best_dp = _safe_get(a, ["decision_points", "best_dp"], {}) or {}
        dp_detected = bool(best_dp) and (best_dp.get("dp_type") or best_dp.get("type") or best_dp.get("level") is not None)
        dp_strength = _as_int(best_dp.get("strength", 0), 0)
        dp_type = str(best_dp.get("dp_type") or best_dp.get("type") or "").upper()

        # KL confluence (si DPType.KEY_LEVEL existe dans best_dp, ou si un DP de type KEY_LEVEL est présent)
        kl_confluence = (dp_type == "KEY_LEVEL") or any(
            str(d.get("dp_type") or d.get("type") or "").upper() == "KEY_LEVEL"
            for d in (_safe_get(a, ["decision_points", "dps"], []) or [])
            if isinstance(d, dict)
        )

        # RR
        rr_ok = _as_bool(_safe_get(a, ["sl_tp", "rr_ok"], False))
        rr_val = _safe_get(a, ["sl_tp", "rr"], None)
        rr_val_f = None if rr_val is None else _as_float(rr_val, 0.0)
        rr_meets_min = (rr_val_f is not None and rr_val_f >= cfg.rr_min)

        # Setup score (si déjà calculé par pipeline)
        setup_score = _safe_get(a, ["setup", "score"], None)
        setup_score_i = _as_int(setup_score, 0)

        # Weakening base
        wb = _as_bool(_safe_get(a, ["base", "weakening_base", "weakened"], False))
        wb_score = _as_int(_safe_get(a, ["base", "weakening_base", "weakness_score"], 0), 0)

        # ── Checklist HLZ ────────────────────────────────────────────────────
        checklist = {
            "Base solide": base_score_i >= cfg.base_solid_min,
            "SB confirmé": sb_ok if cfg.require_sb else True,
            "SDE détecté": sde_detected,
            "SGB créé": sgb_created,
            "SDP validé": sdp_validated if cfg.require_sdp else True,
            "FTB disponible": ftb_valid and not ftb_taken,  # fresh
            "PA actif": pa_detected if cfg.require_pa else True,
            "DP aligné": dp_detected if cfg.require_dp else True,
            "KL confluence": kl_confluence,  # pas forcément requis par défaut
            "RR OK": (rr_ok and rr_meets_min) if cfg.require_rr else True,
            "Pas FLIPPY": (not flippy_detected) if cfg.invalidate_if_flippy else True,
            "SDE non failed": not failed_sde_failed,
            "Base non affaiblie": not wb,
        }

        blocks: list[str] = []
        warnings: list[str] = []

        # ── Hard blocks (INVALID / EXPIRED) ─────────────────────────────────
        # 1) Failed SDE
        if failed_sde_failed:
            # Si invalidation hard => EXPIRED (zone traversée)
            if failed_sde_reason == "INVALIDATED":
                return SetupValidationResult(
                    status=SetupStatus.EXPIRED,
                    is_expired=True,
                    reason="Zone expirée (invalidée / traversée).",
                    checklist=checklist,
                    blocks=["FAILED_SDE_INVALIDATED"],
                    details={
                        "failed_sde_reason": failed_sde_reason,
                    },
                )
            return SetupValidationResult(
                status=SetupStatus.INVALID,
                is_invalid=True,
                reason=f"Setup invalide (Failed SDE: {failed_sde_reason or 'FAILED'}).",
                checklist=checklist,
                blocks=["FAILED_SDE"],
                details={"failed_sde_reason": failed_sde_reason},
            )

        # 2) Flippy
        if cfg.invalidate_if_flippy and flippy_detected:
            return SetupValidationResult(
                status=SetupStatus.INVALID,
                is_invalid=True,
                reason="Setup invalide (zone FLIPPY).",
                checklist=checklist,
                blocks=["FLIPPY"],
                details={"flippy_detected": True},
            )

        # 3) FTB already taken
        if cfg.invalidate_if_ftb_taken and ftb_taken:
            return SetupValidationResult(
                status=SetupStatus.INVALID,
                is_invalid=True,
                reason="Setup invalide (FTB déjà pris / zone plus fraîche).",
                checklist=checklist,
                blocks=["FTB_TAKEN"],
                details={"touches": ftb_touches_i, "ftb_state": ftb_state},
            )

        # ── VALID conditions ────────────────────────────────────────────────
        required_keys = [
            "Base solide",
            "SB confirmé" if cfg.require_sb else None,
            "SDE détecté",
            "SGB créé",
            "SDP validé" if cfg.require_sdp else None,
            "FTB disponible",
            "PA actif" if cfg.require_pa else None,
            "DP aligné" if cfg.require_dp else None,
            "RR OK" if cfg.require_rr else None,
            "Pas FLIPPY" if cfg.invalidate_if_flippy else None,
            "SDE non failed",
        ]
        required_keys = [k for k in required_keys if k is not None]

        all_required_ok = all(checklist.get(k, False) for k in required_keys)

        # Score threshold: si pas de score fourni, on ne bloque pas, mais on avertit
        if setup_score is None:
            warnings.append("Score setup absent (utilise SetupScorer pour scorer automatiquement si besoin).")

        score_ok = (setup_score_i >= cfg.setup_valid_threshold) if setup_score is not None else True

        if all_required_ok and score_ok:
            return SetupValidationResult(
                status=SetupStatus.VALID,
                is_valid=True,
                reason="Setup VALID (critères HLZ alignés).",
                checklist=checklist,
                warnings=warnings,
                details={
                    "setup_score": setup_score_i,
                    "threshold": cfg.setup_valid_threshold,
                    "rr": rr_val_f,
                    "pa_strength": pa_strength,
                    "dp_strength": dp_strength,
                },
            )

        # ── PENDING vs WATCH ────────────────────────────────────────────────
        # PENDING : on a un début de setup (souvent SDE), mais une étape manque.
        pending_step = ""
        if sde_detected and not sgb_created:
            pending_step = "SGB en attente (base/zone d'entrée non confirmée)."
        elif sgb_created and not ftb_valid:
            pending_step = "Zone créée, attente FTB (freshness non OK)."
        elif cfg.require_sdp and not sdp_validated and sde_detected and sgb_created:
            pending_step = "SDP en attente (HEAD non validé)."
        elif cfg.require_dp and not dp_detected and sde_detected:
            pending_step = "DP en attente (Decision Point non aligné)."
        elif cfg.require_pa and not pa_detected and sde_detected:
            pending_step = "PA en attente (pattern d'approche non détecté)."
        elif cfg.require_rr and not (rr_ok and rr_meets_min) and sde_detected:
            pending_step = "RR en attente (SL/TP ou RR insuffisant)."

        # Si on a zone ou SDE => pending, sinon watch
        has_zone = bool(_safe_get(a, ["sd_zone", "zone", "zone_top"], None) is not None)
        if sde_detected or sgb_created or has_zone:
            # si weakening base -> warning (pas forcément invalid)
            if wb:
                warnings.append(f"Base affaiblie (weakness_score={wb_score}).")

            # blocks reasons
            for k in required_keys:
                if not checklist.get(k, False):
                    blocks.append(f"CHECK_{k}")

            return SetupValidationResult(
                status=SetupStatus.PENDING if pending_step else SetupStatus.WATCH,
                is_pending=bool(pending_step),
                reason="Setup en formation." if pending_step else "Zone détectée, surveillance.",
                pending_step=pending_step,
                checklist=checklist,
                warnings=warnings,
                blocks=blocks,
                details={
                    "setup_score": setup_score_i,
                    "threshold": cfg.setup_valid_threshold,
                    "sde_score": sde_score_i,
                    "base_score": base_score_i,
                    "rr": rr_val_f,
                    "dp_type": dp_type,
                },
            )

        # Default : WATCH
        return SetupValidationResult(
            status=SetupStatus.WATCH,
            reason="Aucun setup clair (watch).",
            checklist=checklist,
            warnings=warnings,
            blocks=blocks,
            details={
                "setup_score": setup_score_i,
                "threshold": cfg.setup_valid_threshold,
            },
        )