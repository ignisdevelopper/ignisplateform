"""
routes_ignis_ai.py — Routes API Ignis AI (Ollama local)
Expose un accès HTTP à l’IA locale (Ollama) pour :
- Chat (avec ou sans streaming)
- Génération de rapport d’analyse HLZ / Supply & Demand à partir d’un résultat pipeline
- Summarization / explications rapides
- Status + liste des modèles installés

Base path (via api/__init__.py) :
/api/v1/ai/...

Ollama API (local) :
- GET  {OLLAMA_HOST}/api/tags
- POST {OLLAMA_HOST}/api/chat
- POST {OLLAMA_HOST}/api/generate

Notes :
- On garde ce routeur autonome : même si app/ignis_ai/* n’est pas encore finalisé,
  ces routes fonctionneront via HTTP direct vers Ollama.
- Si tu as déjà app.ignis_ai.ollama_client / report_generator, tu pourras ensuite
  remplacer le fallback HTTP par tes classes internes.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from enum import Enum
from typing import Any, AsyncGenerator, Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()

# ══════════════════════════════════════════════════════════════════════════════
# CONFIG
# ══════════════════════════════════════════════════════════════════════════════

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL_DEFAULT = os.getenv("OLLAMA_MODEL", "llama3.1")
OLLAMA_TIMEOUT_S = float(os.getenv("OLLAMA_TIMEOUT_S", "120"))

# HLZ / S&D prompt defaults
DEFAULT_TEMPERATURE = float(os.getenv("IGNIS_AI_TEMPERATURE", "0.2"))
DEFAULT_TOP_P = float(os.getenv("IGNIS_AI_TOP_P", "0.9"))
DEFAULT_NUM_CTX = int(os.getenv("IGNIS_AI_NUM_CTX", "8192"))

# Hard safety (anti prompt flooding)
MAX_INPUT_CHARS = int(os.getenv("IGNIS_AI_MAX_INPUT_CHARS", "20000"))
MAX_MESSAGES = int(os.getenv("IGNIS_AI_MAX_MESSAGES", "50"))


# ══════════════════════════════════════════════════════════════════════════════
# SCHEMAS
# ══════════════════════════════════════════════════════════════════════════════

class ChatRole(str, Enum):
    SYSTEM    = "system"
    USER      = "user"
    ASSISTANT = "assistant"


class ChatMessage(BaseModel):
    role:    ChatRole
    content: str = Field(..., min_length=1, max_length=MAX_INPUT_CHARS)


class IgnisChatRequest(BaseModel):
    """
    Chat request compatible Ollama /api/chat + enrichissement HLZ.
    - messages : historique conversation
    - symbol/timeframe : optionnel pour inclure un contexte d’analyse (via cache/pipeline)
    - analysis : si fourni, pas besoin de fetch cache
    """
    messages: list[ChatMessage] = Field(..., min_length=1, max_length=MAX_MESSAGES)

    model: Optional[str] = Field(default=None, description="Nom du modèle Ollama (ex: llama3.1)")
    temperature: float = Field(default=DEFAULT_TEMPERATURE, ge=0.0, le=2.0)
    top_p: float = Field(default=DEFAULT_TOP_P, ge=0.0, le=1.0)

    # Contexte HLZ / S&D
    symbol: Optional[str] = Field(default=None, max_length=20)
    timeframe: Optional[str] = Field(default=None, max_length=10)
    include_analysis_context: bool = Field(default=True)
    analysis: Optional[dict[str, Any]] = Field(default=None, description="Résultat pipeline (dict) si déjà connu")

    # Streaming
    stream: bool = Field(default=False)

    @field_validator("symbol")
    @classmethod
    def _upper_symbol(cls, v: Optional[str]) -> Optional[str]:
        return v.upper().strip() if v else v

    @field_validator("timeframe")
    @classmethod
    def _upper_tf(cls, v: Optional[str]) -> Optional[str]:
        return v.upper().strip() if v else v

    @field_validator("messages")
    @classmethod
    def _validate_messages(cls, v: list[ChatMessage]) -> list[ChatMessage]:
        if len(v) > MAX_MESSAGES:
            raise ValueError(f"Trop de messages (max {MAX_MESSAGES}).")
        total = sum(len(m.content) for m in v)
        if total > MAX_INPUT_CHARS:
            raise ValueError(f"Entrée trop grande (max {MAX_INPUT_CHARS} chars).")
        return v


class IgnisChatResponse(BaseModel):
    model: str
    created_at: datetime
    answer: str
    raw: Optional[dict[str, Any]] = None


class IgnisAIStatusResponse(BaseModel):
    ollama_host: str
    ok: bool
    model_default: str
    models: list[str]
    error: Optional[str] = None
    server_version: Optional[str] = None
    checked_at: datetime


class IgnisModelsResponse(BaseModel):
    models: list[dict[str, Any]]
    total: int
    checked_at: datetime


class IgnisReportRequest(BaseModel):
    """
    Génère un rapport HLZ/S&D.
    - symbol/timeframe : si analysis non fournie → on lit le cache, sinon on peut lancer une analyse (option)
    """
    symbol: str = Field(..., min_length=1, max_length=20)
    timeframe: str = Field(default="H4", min_length=1, max_length=10)

    # Si pas de cache (ou force), on peut déclencher une analyse
    auto_analyze_if_missing: bool = Field(default=True)
    force_refresh_analysis: bool = Field(default=False)
    candle_limit: int = Field(default=500, ge=50, le=5000)
    include_ltf: bool = Field(default=False)
    higher_tf: Optional[str] = Field(default=None)

    # IA
    model: Optional[str] = None
    temperature: float = Field(default=DEFAULT_TEMPERATURE, ge=0.0, le=2.0)
    top_p: float = Field(default=DEFAULT_TOP_P, ge=0.0, le=1.0)

    # Entrée directe optionnelle (bypass cache)
    analysis: Optional[dict[str, Any]] = None

    @field_validator("symbol")
    @classmethod
    def _upper_symbol(cls, v: str) -> str:
        return v.upper().strip()

    @field_validator("timeframe")
    @classmethod
    def _upper_tf(cls, v: str) -> str:
        return v.upper().strip()


class IgnisReportResponse(BaseModel):
    symbol: str
    timeframe: str
    model: str
    generated_at: datetime
    from_cache: bool
    ai_summary: Optional[str]
    ai_report: str
    prompt_tokens_est: Optional[int] = None


class SummarizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_INPUT_CHARS)
    model: Optional[str] = None
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)


class SummarizeResponse(BaseModel):
    model: str
    summary: str
    created_at: datetime


# ══════════════════════════════════════════════════════════════════════════════
# OLLAMA HTTP CLIENT (fallback autonome)
# ══════════════════════════════════════════════════════════════════════════════

async def _ollama_get_tags() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT_S) as client:
        r = await client.get(f"{OLLAMA_HOST}/api/tags")
        r.raise_for_status()
        return r.json()


async def _ollama_chat(payload: dict[str, Any], stream: bool = False) -> Any:
    """
    Si stream=False → retourne JSON dict complet
    Si stream=True  → retourne async generator de lignes JSON (bytes)
    """
    async with httpx.AsyncClient(timeout=None) as client:
        if not stream:
            r = await client.post(f"{OLLAMA_HOST}/api/chat", json=payload, timeout=OLLAMA_TIMEOUT_S)
            r.raise_for_status()
            return r.json()

        # Streaming line-by-line
        r = await client.post(f"{OLLAMA_HOST}/api/chat", json=payload, timeout=None)
        r.raise_for_status()

        async def _gen() -> AsyncGenerator[bytes, None]:
            async for line in r.aiter_lines():
                if not line:
                    continue
                yield (line + "\n").encode()

        return _gen()


async def _ollama_generate(payload: dict[str, Any], stream: bool = False) -> Any:
    async with httpx.AsyncClient(timeout=None) as client:
        if not stream:
            r = await client.post(f"{OLLAMA_HOST}/api/generate", json=payload, timeout=OLLAMA_TIMEOUT_S)
            r.raise_for_status()
            return r.json()

        r = await client.post(f"{OLLAMA_HOST}/api/generate", json=payload, timeout=None)
        r.raise_for_status()

        async def _gen() -> AsyncGenerator[bytes, None]:
            async for line in r.aiter_lines():
                if not line:
                    continue
                yield (line + "\n").encode()

        return _gen()


# ══════════════════════════════════════════════════════════════════════════════
# HLZ / S&D PROMPTING HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def _safe_get(obj: Any, path: list[Any], default: Any = None) -> Any:
    """
    Accès tolérant à dict / pydantic / list index.
    path peut contenir des int (index list).
    """
    cur = obj
    for key in path:
        if cur is None:
            return default
        if isinstance(key, int):
            if isinstance(cur, list) and len(cur) > key:
                cur = cur[key]
            else:
                return default
        else:
            if isinstance(cur, dict):
                cur = cur.get(key)
            else:
                cur = getattr(cur, key, None)
    return cur if cur is not None else default


def _analysis_to_context_block(analysis: dict[str, Any]) -> str:
    """
    Convertit un résultat d’analyse (routes_analysis AnalysisResponse en dict)
    en contexte compact pour l’IA.
    """
    sym = _safe_get(analysis, ["symbol"], "")
    tf  = _safe_get(analysis, ["timeframe"], "")

    setup_status = _safe_get(analysis, ["setup", "status"], "UNKNOWN")
    if isinstance(setup_status, dict) and "value" in setup_status:
        setup_status = setup_status["value"]

    score = _safe_get(analysis, ["setup", "score"], 0)
    phase = _safe_get(analysis, ["market_structure", "phase"], "")
    trend = _safe_get(analysis, ["market_structure", "trend"], "")

    z0 = _safe_get(analysis, ["sd_zones", 0], None)
    zone_type = _safe_get(z0, ["zone_type"], None)
    if isinstance(zone_type, dict) and "value" in zone_type:
        zone_type = zone_type["value"]
    zone_top = _safe_get(z0, ["zone_top"], None)
    zone_bot = _safe_get(z0, ["zone_bot"], None)
    ftb_count = _safe_get(z0, ["ftb_count"], None)
    flippy = _safe_get(z0, ["is_flippy"], None)

    pa0 = _safe_get(analysis, ["pa_patterns", 0], None)
    pa_pat = _safe_get(pa0, ["pattern"], "NONE")
    if isinstance(pa_pat, dict) and "value" in pa_pat:
        pa_pat = pa_pat["value"]
    pa_strength = _safe_get(pa0, ["strength"], 0)

    sltp = _safe_get(analysis, ["sl_tp"], None)
    entry = _safe_get(sltp, ["entry"], None)
    sl    = _safe_get(sltp, ["stop_loss"], None)
    tp    = _safe_get(sltp, ["take_profit"], None)
    rr    = _safe_get(sltp, ["rr"], None)

    checklist = _safe_get(analysis, ["setup", "checklist"], {}) or {}

    lines = [
        "=== IGNIS HLZ CONTEXT (Supply & Demand) ===",
        f"Symbol: {sym}",
        f"Timeframe: {tf}",
        f"Setup: {setup_status} | Score: {score}/100",
        f"Market phase: {phase} | Trend: {trend}",
        f"PA: {pa_pat} | Strength: {pa_strength}/100",
    ]

    if zone_top is not None and zone_bot is not None:
        lines += [
            f"Zone: {zone_type} | Bot={zone_bot} Top={zone_top} | FTB={ftb_count} | Flippy={flippy}",
        ]

    if entry is not None and sl is not None and tp is not None:
        lines += [
            f"Trade levels: Entry={entry} SL={sl} TP={tp} RR={rr}",
        ]

    if checklist:
        ok = [k for k, v in checklist.items() if v]
        ko = [k for k, v in checklist.items() if not v]
        lines += [
            "Checklist OK: " + (", ".join(ok) if ok else "none"),
            "Checklist KO: " + (", ".join(ko) if ko else "none"),
        ]

    lines.append("=== END CONTEXT ===")
    return "\n".join(lines)


def _build_hlz_system_prompt() -> str:
    """
    System prompt HLZ : style direct + règles (pas de conseils financiers).
    """
    return (
        "Tu es IGNIS AI, assistant d'analyse technique basé sur la stratégie HLZ (Supply & Demand).\n"
        "Objectif: expliquer clairement la situation, les zones S&D, le contexte HTF/LTF, "
        "les confluences (SDE/SGB/SDP/PA/DP/KL), et les scénarios probables.\n\n"
        "Règles:\n"
        "- Ne donne pas de conseil financier personnalisé.\n"
        "- Reste factuel et actionnable: conditions d'invalidation, confirmations attendues, risques.\n"
        "- Si information manquante, demande une précision.\n"
        "- Format: titres courts, bullets, puis un plan 'Scénario A / Scénario B'.\n"
    )


# ══════════════════════════════════════════════════════════════════════════════
# HELPERS — fetch analysis cache (compatible avec routes_analysis)
# ══════════════════════════════════════════════════════════════════════════════

async def _get_cached_analysis(symbol: str, timeframe: str) -> Optional[dict[str, Any]]:
    """
    Tente de charger l’analyse depuis le cache (mêmes conventions que routes_analysis).
    On essaie plusieurs candle_limit "standards" pour retrouver un cache existant.
    """
    from app.data.cache_manager import CacheManager

    cache = CacheManager()
    for lim in (500, 300, 1000, 2000):
        key = f"analysis:{symbol}:{timeframe}:{lim}"
        try:
            cached = await cache.get(key)
        except Exception:
            cached = None
        if cached:
            # Le cache peut contenir un objet pydantic → on convertit si possible
            if hasattr(cached, "model_dump"):
                return cached.model_dump()
            if isinstance(cached, dict):
                return cached
            # dernier recours
            try:
                return json.loads(cached)
            except Exception:
                return {"_raw": str(cached)}
    return None


async def _run_analysis_if_needed(
    symbol: str,
    timeframe: str,
    candle_limit: int,
    include_ltf: bool,
    higher_tf: Optional[str],
    force_refresh: bool,
) -> dict[str, Any]:
    """
    Lance le pipeline d'analyse via routes_analysis._run_analysis_pipeline (réutilisation).
    Retourne un dict.
    """
    try:
        from app.api.routes_analysis import _run_analysis_pipeline  # type: ignore
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Pipeline analyse non disponible: {str(exc)}",
        )

    resp, _from_cache = await _run_analysis_pipeline(
        symbol=symbol,
        timeframe=timeframe,
        higher_tf=higher_tf,
        candle_limit=candle_limit,
        force_refresh=force_refresh,
        include_ltf=include_ltf,
        include_ai=False,
    )
    # resp est pydantic → dict
    return resp.model_dump() if hasattr(resp, "model_dump") else resp


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — STATUS / MODELS
# ══════════════════════════════════════════════════════════════════════════════

@router.get(
    "/status",
    response_model=IgnisAIStatusResponse,
    summary="Status Ollama local",
)
async def get_ai_status():
    checked_at = datetime.now(timezone.utc)
    try:
        tags = await _ollama_get_tags()
        models = [m.get("name", "") for m in tags.get("models", []) if m.get("name")]
        return IgnisAIStatusResponse(
            ollama_host=OLLAMA_HOST,
            ok=True,
            model_default=OLLAMA_MODEL_DEFAULT,
            models=models,
            server_version=tags.get("version"),
            error=None,
            checked_at=checked_at,
        )
    except Exception as exc:
        return IgnisAIStatusResponse(
            ollama_host=OLLAMA_HOST,
            ok=False,
            model_default=OLLAMA_MODEL_DEFAULT,
            models=[],
            server_version=None,
            error=str(exc),
            checked_at=checked_at,
        )


@router.get(
    "/models",
    response_model=IgnisModelsResponse,
    summary="Lister les modèles installés dans Ollama",
)
async def list_models():
    try:
        tags = await _ollama_get_tags()
        models = tags.get("models", []) or []
        return IgnisModelsResponse(
            models=models,
            total=len(models),
            checked_at=datetime.now(timezone.utc),
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {str(exc)}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — CHAT (normal + streaming)
# ══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/chat",
    response_model=IgnisChatResponse,
    summary="Chat Ignis AI (non-stream)",
)
async def chat(body: IgnisChatRequest):
    if body.stream:
        raise HTTPException(status_code=400, detail="Utilise /chat/stream pour le streaming.")

    model = body.model or OLLAMA_MODEL_DEFAULT

    # Contexte HLZ optionnel
    context_block = ""
    if body.include_analysis_context:
        if body.analysis:
            context_block = _analysis_to_context_block(body.analysis)
        elif body.symbol and body.timeframe:
            cached = await _get_cached_analysis(body.symbol, body.timeframe)
            if cached:
                context_block = _analysis_to_context_block(cached)

    # Inject system prompt + context
    system_prompt = _build_hlz_system_prompt()
    system_content = system_prompt + ("\n\n" + context_block if context_block else "")

    messages = [{"role": "system", "content": system_content}]
    messages += [{"role": m.role.value, "content": m.content} for m in body.messages]

    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {
            "temperature": body.temperature,
            "top_p": body.top_p,
            "num_ctx": DEFAULT_NUM_CTX,
        },
    }

    try:
        data = await _ollama_chat(payload, stream=False)
        answer = (data.get("message") or {}).get("content", "")
        return IgnisChatResponse(
            model=model,
            created_at=datetime.now(timezone.utc),
            answer=answer,
            raw=data,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Ollama error: {str(exc)}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post(
    "/chat/stream",
    summary="Chat Ignis AI (stream SSE)",
    description=(
        "Retourne un flux SSE (text/event-stream) avec des events 'token' et 'done'. "
        "Le client doit concaténer data.token."
    ),
)
async def chat_stream(body: IgnisChatRequest):
    model = body.model or OLLAMA_MODEL_DEFAULT

    context_block = ""
    if body.include_analysis_context:
        if body.analysis:
            context_block = _analysis_to_context_block(body.analysis)
        elif body.symbol and body.timeframe:
            cached = await _get_cached_analysis(body.symbol, body.timeframe)
            if cached:
                context_block = _analysis_to_context_block(cached)

    system_prompt = _build_hlz_system_prompt()
    system_content = system_prompt + ("\n\n" + context_block if context_block else "")

    messages = [{"role": "system", "content": system_content}]
    messages += [{"role": m.role.value, "content": m.content} for m in body.messages]

    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": {
            "temperature": body.temperature,
            "top_p": body.top_p,
            "num_ctx": DEFAULT_NUM_CTX,
        },
    }

    async def _sse() -> AsyncGenerator[bytes, None]:
        try:
            gen = await _ollama_chat(payload, stream=True)

            # Ollama renvoie des lignes JSON
            async for line in gen:
                try:
                    obj = json.loads(line.decode().strip())
                except Exception:
                    continue

                # token chunk
                token = (obj.get("message") or {}).get("content", "")
                done = bool(obj.get("done", False))

                if token:
                    yield f"event: token\ndata: {json.dumps({'token': token})}\n\n".encode()

                if done:
                    yield f"event: done\ndata: {json.dumps({'done': True})}\n\n".encode()
                    break

        except Exception as exc:
            yield f"event: error\ndata: {json.dumps({'error': str(exc)})}\n\n".encode()

    return StreamingResponse(_sse(), media_type="text/event-stream")


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — REPORT HLZ (à partir d’une analyse)
# ══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/report",
    response_model=IgnisReportResponse,
    summary="Générer un rapport HLZ/S&D via Ollama",
)
async def generate_report(body: IgnisReportRequest):
    symbol = body.symbol
    timeframe = body.timeframe
    model = body.model or OLLAMA_MODEL_DEFAULT

    # 1) Récupère analysis
    analysis: Optional[dict[str, Any]] = None
    from_cache = True

    if body.analysis:
        analysis = body.analysis
        from_cache = False
    else:
        if not body.force_refresh_analysis:
            analysis = await _get_cached_analysis(symbol, timeframe)

        if not analysis and body.auto_analyze_if_missing:
            from_cache = False
            analysis = await _run_analysis_if_needed(
                symbol=symbol,
                timeframe=timeframe,
                candle_limit=body.candle_limit,
                include_ltf=body.include_ltf,
                higher_tf=body.higher_tf,
                force_refresh=body.force_refresh_analysis,
            )

        if not analysis:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Aucune analyse trouvée en cache. Active auto_analyze_if_missing=true ou fournis analysis.",
            )

    # 2) Prompt HLZ
    context = _analysis_to_context_block(analysis)

    prompt = (
        _build_hlz_system_prompt()
        + "\n\n"
        + "Tu dois produire un RAPPORT D'ANALYSE HLZ structuré.\n"
        + "Format imposé:\n"
        + "1) Résumé (3-6 bullets)\n"
        + "2) Contexte Market Structure (phase / swings / SB)\n"
        + "3) Zone S&D principale (type, top/bot, SDE/SGB/SDP, FTB, invalidation)\n"
        + "4) PA patterns (ACCU / 3D / FTL / 69 / Hidden SDE) + ce que ça implique\n"
        + "5) Plan de trade (si niveaux fournis): entry/SL/TP/RR + conditions de validation\n"
        + "6) Scénarios: A (setup respecté) / B (invalidation)\n"
        + "7) Checklist finale (OK/KO)\n\n"
        + context
    )

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": body.temperature,
            "top_p": body.top_p,
            "num_ctx": DEFAULT_NUM_CTX,
        },
    }

    try:
        data = await _ollama_generate(payload, stream=False)
        report_text = data.get("response", "") or ""
        summary_text = None

        # Mini summary (2ème passe rapide) — optionnelle
        try:
            sum_payload = {
                "model": model,
                "prompt": (
                    "Résume en 5 bullets maximum, sans blabla, ce rapport:\n\n"
                    + report_text[:8000]
                ),
                "stream": False,
                "options": {"temperature": 0.2, "top_p": 0.9, "num_ctx": DEFAULT_NUM_CTX},
            }
            sum_data = await _ollama_generate(sum_payload, stream=False)
            summary_text = (sum_data.get("response", "") or "").strip()
        except Exception as exc:
            log.warning("ai_summary_failed", error=str(exc))

        return IgnisReportResponse(
            symbol=symbol,
            timeframe=timeframe,
            model=model,
            generated_at=datetime.now(timezone.utc),
            from_cache=from_cache,
            ai_summary=summary_text,
            ai_report=report_text.strip(),
            prompt_tokens_est=len(prompt) // 4,  # estimation grossière
        )

    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Ollama error: {str(exc)}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — SUMMARIZE (utilitaire)
# ══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/summarize",
    response_model=SummarizeResponse,
    summary="Résumer un texte via Ollama",
)
async def summarize(body: SummarizeRequest):
    model = body.model or OLLAMA_MODEL_DEFAULT

    payload = {
        "model": model,
        "prompt": (
            "Résume le texte suivant en FRANÇAIS en 5 à 10 bullets max, "
            "en gardant les éléments techniques importants.\n\n"
            + body.text
        ),
        "stream": False,
        "options": {
            "temperature": body.temperature,
            "top_p": 0.9,
            "num_ctx": DEFAULT_NUM_CTX,
        },
    }

    try:
        data = await _ollama_generate(payload, stream=False)
        summary = (data.get("response") or "").strip()
        return SummarizeResponse(
            model=model,
            summary=summary,
            created_at=datetime.now(timezone.utc),
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Ollama error: {str(exc)}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
