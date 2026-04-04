"""
ignis_ai/ollama_client.py — Client Ollama local (IGNIS)

Fonctions :
- chat() : /api/chat (avec ou sans streaming)
- generate() : /api/generate (avec ou sans streaming)
- tags() : /api/tags (liste modèles)

Design :
- Async (httpx)
- Streaming : retourne un async generator de dicts (lignes JSON Ollama)
- Tolérant : retries sur erreurs réseau / 429

Ollama API :
- GET  /api/tags
- POST /api/chat
- POST /api/generate

Réponses streaming :
- Ollama renvoie une succession de lignes JSON (JSONL), ex:
    {"message":{"role":"assistant","content":"..."}, "done": false, ...}
    {"done": true, ...}
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Optional

import httpx
import structlog

log = structlog.get_logger(__name__)

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
OLLAMA_TIMEOUT_S = float(os.getenv("OLLAMA_TIMEOUT_S", "120"))

# Retry
MAX_RETRY_ATTEMPTS = int(os.getenv("OLLAMA_MAX_RETRY", "6"))
RETRY_BASE_DELAY = float(os.getenv("OLLAMA_RETRY_BASE_DELAY", "0.8"))
RETRY_MAX_DELAY = float(os.getenv("OLLAMA_RETRY_MAX_DELAY", "20"))


# ═════════════════════════════════════════════════════════════════════════════=
# Data models (lightweight)
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class OllamaClientConfig:
    host: str = OLLAMA_HOST
    timeout_s: float = OLLAMA_TIMEOUT_S

    max_retry_attempts: int = MAX_RETRY_ATTEMPTS
    retry_base_delay: float = RETRY_BASE_DELAY
    retry_max_delay: float = RETRY_MAX_DELAY


@dataclass(frozen=True)
class OllamaChatMessage:
    role: str
    content: str

    def to_dict(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


@dataclass
class OllamaChatResponse:
    model: str
    created_at: datetime
    content: str
    raw: dict[str, Any]


@dataclass
class OllamaGenerateResponse:
    model: str
    created_at: datetime
    response: str
    raw: dict[str, Any]


# ═════════════════════════════════════════════════════════════════════════════=
# Client
# ═════════════════════════════════════════════════════════════════════════════=

class OllamaClient:
    """
    Client Ollama async.

    Usage:
        client = OllamaClient()
        data = await client.chat(model="llama3.1", messages=[...], stream=False, options={...})

        gen = await client.chat(..., stream=True)
        async for obj in gen: ...
    """

    def __init__(self, config: Optional[OllamaClientConfig] = None) -> None:
        self.config = config or OllamaClientConfig()

    # ── API ────────────────────────────────────────────────────────────────

    async def tags(self) -> dict[str, Any]:
        return await self._get("/api/tags")

    async def chat(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        stream: bool = False,
        options: Optional[dict[str, Any]] = None,
        keep_alive: Optional[str] = None,
    ) -> Any:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": bool(stream),
        }
        if options:
            payload["options"] = options
        if keep_alive is not None:
            payload["keep_alive"] = keep_alive

        return await self._post_jsonl("/api/chat", payload, stream=stream)

    async def generate(
        self,
        *,
        model: str,
        prompt: str,
        stream: bool = False,
        options: Optional[dict[str, Any]] = None,
        system: Optional[str] = None,
        keep_alive: Optional[str] = None,
    ) -> Any:
        payload: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "stream": bool(stream),
        }
        if options:
            payload["options"] = options
        if system:
            payload["system"] = system
        if keep_alive is not None:
            payload["keep_alive"] = keep_alive

        return await self._post_jsonl("/api/generate", payload, stream=stream)

    # ── Internals ───────────────────────────────────────────────────────────

    async def _get(self, path: str) -> dict[str, Any]:
        url = self.config.host + path
        timeout = httpx.Timeout(connect=10.0, read=self.config.timeout_s, write=10.0, pool=5.0)

        attempt = 0
        while True:
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    r = await client.get(url)
                    r.raise_for_status()
                    return r.json()
            except Exception as exc:
                attempt += 1
                if attempt > self.config.max_retry_attempts:
                    raise RuntimeError(f"Ollama GET failed: {exc}") from exc
                delay = min(self.config.retry_base_delay * (2 ** (attempt - 1)), self.config.retry_max_delay)
                log.warning("ollama_get_retry", path=path, attempt=attempt, delay=delay, error=str(exc))
                await asyncio.sleep(delay)

    async def _post_jsonl(self, path: str, payload: dict[str, Any], *, stream: bool) -> Any:
        url = self.config.host + path

        timeout = httpx.Timeout(
            connect=10.0,
            read=None if stream else self.config.timeout_s,
            write=10.0,
            pool=5.0,
        )

        attempt = 0
        while True:
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    if not stream:
                        r = await client.post(url, json=payload, timeout=self.config.timeout_s)
                        # handle errors
                        if r.status_code == 200:
                            return r.json()

                        data = None
                        try:
                            data = r.json()
                        except Exception:
                            data = r.text

                        # retry on 429/5xx
                        if r.status_code in (429, 500, 502, 503, 504):
                            attempt += 1
                            if attempt > self.config.max_retry_attempts:
                                raise RuntimeError(f"Ollama error {r.status_code}: {data}")

                            # if retry_after
                            retry_after = None
                            if isinstance(data, dict):
                                retry_after = data.get("retry_after") or data.get("retryAfter")
                            delay = float(retry_after) if retry_after else min(self.config.retry_base_delay * (2 ** (attempt - 1)), self.config.retry_max_delay)
                            log.warning("ollama_post_retry", path=path, attempt=attempt, delay=delay, status=r.status_code)
                            await asyncio.sleep(delay)
                            continue

                        raise RuntimeError(f"Ollama error {r.status_code}: {data}")

                    # streaming
                    r = await client.post(url, json=payload, timeout=None)
                    if r.status_code != 200:
                        try:
                            data = r.json()
                        except Exception:
                            data = r.text
                        raise RuntimeError(f"Ollama error {r.status_code}: {data}")

                    async def _gen() -> AsyncGenerator[dict[str, Any], None]:
                        async for line in r.aiter_lines():
                            if not line:
                                continue
                            try:
                                yield json.loads(line)
                            except Exception:
                                continue

                    return _gen()

            except (httpx.ConnectError, httpx.ReadTimeout, httpx.WriteTimeout) as exc:
                attempt += 1
                if attempt > self.config.max_retry_attempts:
                    raise RuntimeError(f"Ollama HTTP failed: {exc}") from exc
                delay = min(self.config.retry_base_delay * (2 ** (attempt - 1)), self.config.retry_max_delay)
                log.warning("ollama_http_retry", path=path, attempt=attempt, delay=delay, error=str(exc))
                await asyncio.sleep(delay)
