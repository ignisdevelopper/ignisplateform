"""
ignis_ai/report_generator.py — Générateur de rapport HLZ via Ollama (IGNIS)

Rôle :
- Prendre un résultat d’analyse (pipeline dict) + options IA
- Construire un prompt HLZ (PromptBuilder)
- Appeler Ollama (OllamaClient) en /api/generate
- Retourner un ReportResult structuré :
    • report_text
    • optional summary
    • metadata (model, tokens estimate, timings)

Design :
- Async
- Tolérant : fallback HTTP si OllamaClient absent
- Safe : truncate context

Utilisé par :
- api/routes_ignis_ai.py (optionnel)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

import structlog

from app.ignis_ai.ollama_client import OllamaClient, OllamaClientConfig
from app.ignis_ai.prompt_builder import PromptBuilder, PromptContext, PromptBuilderConfig

log = structlog.get_logger(__name__)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class ReportConfig:
    model: str = "llama3.1"

    temperature: float = 0.2
    top_p: float = 0.9
    num_ctx: int = 8192

    include_summary: bool = True
    summary_max_chars: int = 8000

    # Prompt builder settings
    max_context_chars: int = 12000
    include_raw_json: bool = False

    # Keep-alive (ollama)
    keep_alive: Optional[str] = None  # e.g. "10m"


@dataclass
class ReportResult:
    symbol: str
    timeframe: str
    model: str
    generated_at: datetime = field(default_factory=_now_utc)

    report: str = ""
    summary: Optional[str] = None

    prompt_tokens_est: int = 0
    duration_ms: int = 0

    raw: Optional[dict[str, Any]] = None
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "model": self.model,
            "generated_at": self.generated_at.isoformat(),
            "report": self.report,
            "summary": self.summary,
            "prompt_tokens_est": self.prompt_tokens_est,
            "duration_ms": self.duration_ms,
            "raw": self.raw,
            "details": self.details,
        }


class ReportGenerator:
    """
    Génère un rapport HLZ complet (avec option summary).

    Usage:
        gen = ReportGenerator()
        rep = await gen.generate(analysis_dict, symbol="BTCUSDT", timeframe="H4")
    """

    def __init__(
        self,
        *,
        ollama_client: Optional[OllamaClient] = None,
        prompt_builder: Optional[PromptBuilder] = None,
    ) -> None:
        self.ollama = ollama_client or OllamaClient(OllamaClientConfig())
        self.prompts = prompt_builder or PromptBuilder(PromptBuilderConfig())

    async def generate(
        self,
        analysis: dict[str, Any],
        *,
        symbol: str,
        timeframe: str,
        config: Optional[ReportConfig] = None,
        question: Optional[str] = None,
        extra_notes: Optional[str] = None,
    ) -> ReportResult:
        cfg = config or ReportConfig()

        # configure prompt builder limits
        pb_cfg = PromptBuilderConfig(
            max_context_chars=cfg.max_context_chars,
            max_raw_json_chars=8000,
        )
        self.prompts = PromptBuilder(pb_cfg)

        ctx = PromptContext(
            symbol=symbol,
            timeframe=timeframe,
            analysis=analysis,
            user_question=question,
            include_raw_json=cfg.include_raw_json,
            extra_notes=extra_notes,
        )

        prompt = self.prompts.build_report_prompt(ctx=ctx)
        tokens_est = self.prompts.estimate_tokens(prompt)

        t0 = time.time()
        raw = await self.ollama.generate(
            model=cfg.model,
            prompt=prompt,
            stream=False,
            keep_alive=cfg.keep_alive,
            options={
                "temperature": cfg.temperature,
                "top_p": cfg.top_p,
                "num_ctx": cfg.num_ctx,
            },
        )
        dt_ms = int((time.time() - t0) * 1000)

        report_text = (raw.get("response", "") if isinstance(raw, dict) else "") or ""
        report_text = report_text.strip()

        summary_text: Optional[str] = None
        if cfg.include_summary and report_text:
            try:
                sum_prompt = (
                    "Résume en 5 bullets maximum, sans blabla, ce rapport HLZ:\n\n"
                    + report_text[: cfg.summary_max_chars]
                )
                raw_sum = await self.ollama.generate(
                    model=cfg.model,
                    prompt=sum_prompt,
                    stream=False,
                    keep_alive=cfg.keep_alive,
                    options={
                        "temperature": 0.2,
                        "top_p": 0.9,
                        "num_ctx": cfg.num_ctx,
                    },
                )
                summary_text = ((raw_sum.get("response", "") if isinstance(raw_sum, dict) else "") or "").strip() or None
            except Exception as exc:
                log.warning("report_summary_failed", error=str(exc))

        return ReportResult(
            symbol=symbol.upper().strip(),
            timeframe=timeframe.upper().strip(),
            model=cfg.model,
            report=report_text,
            summary=summary_text,
            prompt_tokens_est=tokens_est,
            duration_ms=dt_ms,
            raw=raw if isinstance(raw, dict) else None,
            details={
                "temperature": cfg.temperature,
                "top_p": cfg.top_p,
                "num_ctx": cfg.num_ctx,
                "include_raw_json": cfg.include_raw_json,
            },
        )
