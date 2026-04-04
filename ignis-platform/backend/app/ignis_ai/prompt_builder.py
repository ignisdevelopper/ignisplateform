"""
ignis_ai/prompt_builder.py — Prompt Builder HLZ / Supply & Demand (IGNIS)

But :
- Construire des prompts cohérents et "stables" pour Ollama, en gardant :
  • contexte HLZ (structure, zones, PA, advanced, DP, SL/TP)
  • consignes de format
  • sécurité (pas de conseil financier perso)

Ce module est utilisé par :
- api/routes_ignis_ai.py (si tu veux remplacer le fallback HTTP)
- ignis_ai/report_generator.py
- ignis_ai/chat_handler.py

Design :
- Stateless
- Tolérant : analysis peut être dict/pydantic/dataclass
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict, is_dataclass
from datetime import datetime
from typing import Any, Optional

import structlog

from app import SetupStatus

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


def _truncate(text: str, max_chars: int) -> str:
    s = str(text)
    if max_chars <= 0 or len(s) <= max_chars:
        return s
    suffix = "\n\n...[context truncated]..."
    return s[: max_chars - len(suffix)] + suffix


def _fmt_float(x: Any, nd: int = 5) -> str:
    try:
        return f"{float(x):.{nd}f}"
    except Exception:
        return str(x)


def _json_compact(obj: Any, max_chars: int = 12000) -> str:
    try:
        s = json.dumps(obj, ensure_ascii=False, default=str, indent=2)
    except Exception:
        s = str(obj)
    return _truncate(s, max_chars=max_chars)


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class PromptBuilderConfig:
    language: str = "fr"

    # Persona
    system_title: str = "IGNIS AI"
    persona: str = (
        "Tu es IGNIS AI, assistant d'analyse technique basé sur la stratégie HLZ (Supply & Demand)."
    )

    # Safety
    no_financial_advice: bool = True

    # Formatting defaults
    default_chat_format: str = (
        "Format:\n"
        "- Réponse courte et structurée\n"
        "- Points clés (bullets)\n"
        "- Puis Scénario A / Scénario B\n"
        "- Mentionne validation + invalidation\n"
    )

    default_report_format: str = (
        "Format imposé:\n"
        "1) Résumé (3-6 bullets)\n"
        "2) Contexte Market Structure (phase / swings / SB)\n"
        "3) Zone S&D principale (type, top/bot, SDE/SGB/SDP, FTB, invalidation)\n"
        "4) PA patterns (ACCU / 3D / FTL / 69 / Hidden SDE)\n"
        "5) Advanced patterns (OU/IOU/FlagLimit/CounterAttack/IA) si présents\n"
        "6) Decision Points (SDP/SB/KL/TL)\n"
        "7) Plan de trade (si niveaux fournis): entry/SL/TP/RR + conditions\n"
        "8) Scénarios A/B\n"
        "9) Checklist finale (OK/KO)\n"
    )

    # Context size limits (anti prompt flooding)
    max_context_chars: int = 12000
    max_raw_json_chars: int = 8000


@dataclass
class PromptContext:
    """
    Contexte utilisé pour construire un prompt.
    """
    symbol: Optional[str] = None
    timeframe: Optional[str] = None

    analysis: Optional[dict[str, Any]] = None

    # Optional extra info
    user_question: Optional[str] = None
    include_raw_json: bool = False
    extra_notes: Optional[str] = None


# ═════════════════════════════════════════════════════════════════════════════=
# PromptBuilder
# ═════════════════════════════════════════════════════════════════════════════=

class PromptBuilder:
    """
    Construit les prompts pour Chat / Report / Summarize.

    Convention output :
    - build_chat_system_prompt(...) => str
    - build_analysis_context(...)   => str
    - build_chat_messages(...)      => list[dict] compatible Ollama /api/chat
    """

    def __init__(self, config: Optional[PromptBuilderConfig] = None) -> None:
        self.config = config or PromptBuilderConfig()

    # ──────────────────────────────────────────────────────────────────────
    # System prompts
    # ──────────────────────────────────────────────────────────────────────

    def build_chat_system_prompt(self) -> str:
        c = self.config
        lines = [
            f"{c.persona}",
            "",
            "Objectif : expliquer clairement la situation, les zones S&D, le contexte HTF/LTF, "
            "les confluences (SDE/SGB/SDP/PA/DP/KL), et les scénarios probables.",
        ]
        if c.no_financial_advice:
            lines += [
                "",
                "Règles :",
                "- Ne donne pas de conseil financier personnalisé.",
                "- Reste factuel et actionnable : conditions d'invalidation, confirmations attendues, risques.",
                "- Si une info manque, demande une précision.",
            ]
        lines += ["", c.default_chat_format.strip()]
        return "\n".join(lines).strip()

    def build_report_system_prompt(self) -> str:
        c = self.config
        lines = [
            f"{c.persona}",
            "",
            "Objectif : produire un rapport HLZ complet à partir du contexte fourni.",
        ]
        if c.no_financial_advice:
            lines += [
                "",
                "Règles :",
                "- Ne donne pas de conseil financier personnalisé.",
                "- Donne des conditions (validation/invalidation), pas des certitudes.",
            ]
        lines += ["", c.default_report_format.strip()]
        return "\n".join(lines).strip()

    # ──────────────────────────────────────────────────────────────────────
    # Context builder
    # ──────────────────────────────────────────────────────────────────────

    def build_analysis_context(self, ctx: PromptContext) -> str:
        """
        Construit un bloc "HLZ CONTEXT" compact à partir du résultat pipeline.
        """
        c = self.config
        a = ctx.analysis or {}

        symbol = (ctx.symbol or _safe_get(a, ["symbol"], "") or "").upper()
        timeframe = (ctx.timeframe or _safe_get(a, ["timeframe"], "") or "").upper()

        setup = _safe_get(a, ["setup"], {}) or {}
        setup_status = setup.get("status") or setup.get("setup_status") or "UNKNOWN"
        setup_score = setup.get("score", setup.get("setup_score", 0))

        # Market structure
        ms = _safe_get(a, ["market_structure"], {}) or {}
        phase = _safe_get(ms, ["phase", "phase"], None) or _safe_get(ms, ["phase"], None)
        # Depending on our pipeline format, ms["phase"] is a dict (PhaseResult asdict)
        if isinstance(phase, dict):
            phase_val = phase.get("phase") or phase.get("trend") or ""
            trend_val = phase.get("trend") or ""
        else:
            phase_val = str(phase or "")
            trend_val = str(_safe_get(ms, ["phase", "trend"], "") or "")

        swings = _safe_get(ms, ["swings"], {}) or {}
        structure = swings.get("structure") or swings.get("trend") or swings.get("details", {}).get("structure") or ""
        sb = _safe_get(ms, ["structure_break"], {}) or {}
        sb_dir = sb.get("direction", "")
        sb_level = sb.get("broken_level", None)

        # Zone block
        zone_block = _safe_get(a, ["sd_zone", "zone"], {}) or {}
        z_top = zone_block.get("zone_top")
        z_bot = zone_block.get("zone_bot")
        z_type = zone_block.get("zone_type") or zone_block.get("type") or ""

        sde = _safe_get(a, ["sd_zone", "sde"], {}) or {}
        sgb = _safe_get(a, ["sd_zone", "sgb"], {}) or {}
        sdp = _safe_get(a, ["sd_zone", "sdp"], {}) or {}
        ftb = _safe_get(a, ["sd_zone", "ftb"], {}) or {}
        flippy = _safe_get(a, ["sd_zone", "flippy"], {}) or {}
        failed = _safe_get(a, ["sd_zone", "failed_sde"], {}) or {}

        # PA / Advanced best
        pa_best = _safe_get(a, ["pa", "best"], {}) or {}
        adv_best = _safe_get(a, ["advanced", "best"], {}) or {}

        # DP
        best_dp = _safe_get(a, ["decision_points", "best_dp"], {}) or {}

        # SLTP
        sltp = _safe_get(a, ["sl_tp"], {}) or {}
        entry = sltp.get("entry")
        sl = sltp.get("stop_loss") or sltp.get("sl")
        tp = sltp.get("take_profit") or sltp.get("tp")
        rr = sltp.get("rr")

        # Checklist
        checklist = setup.get("checklist", {})

        lines: list[str] = []
        lines.append("=== IGNIS HLZ CONTEXT ===")
        lines.append(f"Symbol: {symbol}")
        lines.append(f"Timeframe: {timeframe}")
        lines.append(f"Setup: {setup_status} | Score: {setup_score}/100")

        if phase_val or trend_val:
            lines.append(f"Market phase: {phase_val} | Trend: {trend_val}")
        if structure:
            lines.append(f"Swing structure: {structure}")
        if sb_level is not None:
            lines.append(f"SB: {sb_dir} | Broken level: {sb_level}")

        if z_top is not None and z_bot is not None:
            lines.append(f"Zone: {z_type} | Bot={z_bot} Top={z_top}")

        # Components status
        lines.append(
            "Components: "
            f"SDE={bool(_safe_get(sde, ['detected'], False) or zone_block.get('sde_detected'))} "
            f"SGB={bool(_safe_get(sgb, ['created'], False) or zone_block.get('zone_top') is not None)} "
            f"SDP={bool(_safe_get(sdp, ['sdp_validated'], False) or str(_safe_get(sdp,['status'], '')).upper()=='VALIDATED')} "
            f"FTB_valid={bool(_safe_get(ftb,['ftb_valid'], False))} touches={_safe_get(ftb,['touches'], None)} "
            f"FLIPPY={bool(_safe_get(flippy,['detected'], False) or zone_block.get('is_flippy'))} "
            f"FAILED={bool(_safe_get(failed,['failed'], False))}"
        )

        # Best signals
        if pa_best:
            lines.append(f"PA best: {pa_best.get('pattern') or pa_best.get('type') or pa_best.get('pa_pattern')} | strength={pa_best.get('strength')}")
        if adv_best:
            lines.append(f"Advanced best: {adv_best.get('pattern') or adv_best.get('type')} | strength={adv_best.get('strength')}")

        if best_dp:
            lines.append(f"Best DP: {best_dp.get('dp_type') or best_dp.get('type')} level={best_dp.get('level')} strength={best_dp.get('strength')}")

        if entry is not None and sl is not None and tp is not None:
            lines.append(f"Trade levels: Entry={entry} SL={sl} TP={tp} RR={rr}")

        if checklist:
            ok = [k for k, v in checklist.items() if v]
            ko = [k for k, v in checklist.items() if not v]
            lines.append("Checklist OK: " + (", ".join(ok) if ok else "none"))
            lines.append("Checklist KO: " + (", ".join(ko) if ko else "none"))

        if ctx.extra_notes:
            lines.append("")
            lines.append("Notes:")
            lines.append(str(ctx.extra_notes))

        if ctx.include_raw_json:
            lines.append("")
            lines.append("Raw analysis JSON (truncated):")
            lines.append(_json_compact(a, max_chars=c.max_raw_json_chars))

        lines.append("=== END CONTEXT ===")

        return _truncate("\n".join(lines), max_chars=c.max_context_chars)

    # ──────────────────────────────────────────────────────────────────────
    # Message builders
    # ──────────────────────────────────────────────────────────────────────

    def build_chat_messages(
        self,
        *,
        ctx: PromptContext,
        messages: list[dict[str, str]],
    ) -> list[dict[str, str]]:
        """
        Construit une liste de messages compatible Ollama /api/chat.
        messages = [{"role":"user"|"assistant","content":"..."}...]
        """
        system = self.build_chat_system_prompt()
        context = self.build_analysis_context(ctx) if ctx.analysis else ""

        sys_content = system + ("\n\n" + context if context else "")
        out = [{"role": "system", "content": sys_content}]

        # append dialog
        for m in messages:
            role = str(m.get("role", "user"))
            content = str(m.get("content", ""))
            if not content:
                continue
            out.append({"role": role, "content": _truncate(content, self.config.max_context_chars)})

        return out

    def build_report_prompt(self, *, ctx: PromptContext) -> str:
        """
        Prompt "generate" (Ollama /api/generate) pour un rapport HLZ.
        """
        system = self.build_report_system_prompt()
        context = self.build_analysis_context(ctx) if ctx.analysis else "Aucun contexte fourni."

        user_part = "Produis le rapport HLZ complet à partir du contexte suivant."
        if ctx.user_question:
            user_part += "\n\nQuestion/objectif:\n" + str(ctx.user_question).strip()

        prompt = system + "\n\n" + user_part + "\n\n" + context
        return _truncate(prompt, max_chars=self.config.max_context_chars + 4000)

    def build_summarize_prompt(self, *, text: str) -> str:
        """
        Prompt utilitaire résumé.
        """
        base = (
            f"{self.config.persona}\n\n"
            "Résume le texte suivant en FRANÇAIS en 5 à 10 bullets max, "
            "en gardant les éléments techniques importants.\n\n"
        )
        return _truncate(base + str(text), max_chars=self.config.max_context_chars)

    # ──────────────────────────────────────────────────────────────────────
    # Utilities
    # ──────────────────────────────────────────────────────────────────────

    @staticmethod
    def estimate_tokens(text: str) -> int:
        """
        Estimation grossière tokens ~ chars/4 (utile pour debug).
        """
        return max(0, int(len(str(text)) / 4))
