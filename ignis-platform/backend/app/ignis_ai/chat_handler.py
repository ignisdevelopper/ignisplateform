"""
ignis_ai/chat_handler.py — Ignis AI Chat Handler (Ollama local) (IGNIS)

Responsabilité :
- Gérer des sessions de chat en mémoire (multi-utilisateurs) avec TTL
- Fournir un handler WebSocket temps réel (stream tokens) vers le frontend
- Orchestrer l’appel à Ollama (/api/chat) en mode normal ou streaming

Design :
- Stateless côté modèle (Ollama), stateful côté sessions (mémoire process)
- Tolérant : si app.ignis_ai.ollama_client n’est pas encore finalisé, fallback HTTP direct
- Sécurisé : limites taille messages, nb messages, rate-limit simple, cleanup TTL

Message protocol (WebSocket) — simple & stable :
Client -> Server:
{
  "type": "hello" | "chat" | "reset" | "ping",
  "data": {...}
}

Server -> Client:
{
  "type": "connected" | "token" | "message" | "done" | "error" | "pong",
  "data": {...}
}

Exemple client chat:
{
  "type": "chat",
  "data": {
    "session_id": "optional",
    "content": "Analyse BTCUSDT H4...",
    "stream": true,
    "model": "llama3.1",
    "temperature": 0.2,
    "top_p": 0.9,
    "context": { ... }   // optionnel : contexte HLZ/pipeline
  }
}
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, AsyncGenerator, Optional, Protocol, runtime_checkable
from uuid import uuid4

import httpx
import structlog
from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

log = structlog.get_logger(__name__)

# ═════════════════════════════════════════════════════════════════════════════=
# Defaults / Limits
# ═════════════════════════════════════════════════════════════════════════════=

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL_DEFAULT = os.getenv("OLLAMA_MODEL", "llama3.1")

DEFAULT_TEMPERATURE = float(os.getenv("IGNIS_AI_TEMPERATURE", "0.2"))
DEFAULT_TOP_P = float(os.getenv("IGNIS_AI_TOP_P", "0.9"))
DEFAULT_NUM_CTX = int(os.getenv("IGNIS_AI_NUM_CTX", "8192"))

MAX_INPUT_CHARS = int(os.getenv("IGNIS_AI_MAX_INPUT_CHARS", "20000"))
MAX_MESSAGES = int(os.getenv("IGNIS_AI_MAX_MESSAGES", "50"))

SESSION_TTL_SECONDS = int(os.getenv("IGNIS_AI_SESSION_TTL", "3600"))  # 1h
CLEANUP_INTERVAL_SECONDS = int(os.getenv("IGNIS_AI_SESSION_CLEANUP_INTERVAL", "60"))

# Basic abuse protection
MAX_REQ_PER_MINUTE = int(os.getenv("IGNIS_AI_MAX_REQ_PER_MINUTE", "60"))

HTTP_CONNECT_TIMEOUT = float(os.getenv("IGNIS_AI_HTTP_CONNECT_TIMEOUT", "10"))
HTTP_READ_TIMEOUT = float(os.getenv("IGNIS_AI_HTTP_READ_TIMEOUT", "120"))


# ═════════════════════════════════════════════════════════════════════════════=
# Types
# ═════════════════════════════════════════════════════════════════════════════=

class ChatRole(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class WSChatMessageType(str, Enum):
    # Client -> Server
    HELLO = "hello"
    CHAT = "chat"
    RESET = "reset"
    PING = "ping"

    # Server -> Client
    CONNECTED = "connected"
    TOKEN = "token"
    MESSAGE = "message"
    DONE = "done"
    ERROR = "error"
    PONG = "pong"


@dataclass
class ChatMessage:
    role: ChatRole
    content: str
    ts: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_ollama(self) -> dict[str, str]:
        return {"role": self.role.value, "content": self.content}


@dataclass
class ChatConfig:
    # Ollama
    ollama_host: str = OLLAMA_HOST
    model_default: str = OLLAMA_MODEL_DEFAULT
    num_ctx: int = DEFAULT_NUM_CTX
    temperature: float = DEFAULT_TEMPERATURE
    top_p: float = DEFAULT_TOP_P

    # Sessions
    session_ttl_seconds: int = SESSION_TTL_SECONDS
    cleanup_interval_seconds: int = CLEANUP_INTERVAL_SECONDS

    # Limits
    max_messages: int = MAX_MESSAGES
    max_input_chars: int = MAX_INPUT_CHARS
    max_req_per_minute: int = MAX_REQ_PER_MINUTE

    # Prompting
    system_prompt: str = (
        "Tu es IGNIS AI, assistant d'analyse technique basé sur la stratégie HLZ (Supply & Demand).\n"
        "Reste factuel, structuré, et explique les conditions de validation/invalidation.\n"
        "Ne donne pas de conseil financier personnalisé.\n"
    )


@dataclass
class ChatSession:
    session_id: str = field(default_factory=lambda: str(uuid4()))
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    # message history (system prompt not duplicated here; injected at request time)
    messages: list[ChatMessage] = field(default_factory=list)

    # metadata
    user_id: Optional[str] = None
    client_ip: Optional[str] = None
    user_agent: str = ""

    # rate limiting (simple sliding window)
    req_timestamps: list[float] = field(default_factory=list)  # monotonic times

    closed: bool = False

    def touch(self) -> None:
        self.updated_at = datetime.now(timezone.utc)

    def is_expired(self, ttl_seconds: int) -> bool:
        return (datetime.now(timezone.utc) - self.updated_at).total_seconds() > ttl_seconds

    def append(self, role: ChatRole, content: str) -> None:
        self.messages.append(ChatMessage(role=role, content=content))
        self.touch()

    def trim(self, max_messages: int) -> None:
        if max_messages <= 0:
            return
        if len(self.messages) > max_messages:
            self.messages = self.messages[-max_messages:]


# ═════════════════════════════════════════════════════════════════════════════=
# Ollama client interface (optional)
# ═════════════════════════════════════════════════════════════════════════════=

@runtime_checkable
class OllamaClientLike(Protocol):
    async def chat(self, *, model: str, messages: list[dict[str, str]], stream: bool, options: dict[str, Any]) -> Any: ...


async def _ollama_chat_http(
    *,
    host: str,
    payload: dict[str, Any],
    stream: bool,
) -> Any:
    """
    Fallback HTTP direct vers Ollama (/api/chat).
    - stream=False => retourne dict JSON
    - stream=True  => retourne async generator de dicts (par lignes JSON)
    """
    url = f"{host}/api/chat"

    timeout = httpx.Timeout(
        connect=HTTP_CONNECT_TIMEOUT,
        read=None if stream else HTTP_READ_TIMEOUT,
        write=10.0,
        pool=5.0,
    )

    async with httpx.AsyncClient(timeout=timeout) as client:
        if not stream:
            r = await client.post(url, json=payload)
            r.raise_for_status()
            return r.json()

        r = await client.post(url, json=payload, timeout=None)
        r.raise_for_status()

        async def _gen() -> AsyncGenerator[dict[str, Any], None]:
            async for line in r.aiter_lines():
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except Exception:
                    continue

        return _gen()


# ═════════════════════════════════════════════════════════════════════════════=
# Handler
# ═════════════════════════════════════════════════════════════════════════════=

class IgnisChatHandler:
    """
    Gestionnaire sessions + handler WebSocket pour chat Ollama.

    Tu peux l'utiliser de 2 façons :
    1) API WS:
        conn_id = await handler.connect(ws)
        await handler.handle_connection(conn_id)

    2) API pure python:
        session = handler.create_session(...)
        answer = await handler.chat(session.session_id, "question", stream=False)
    """

    def __init__(self, config: Optional[ChatConfig] = None, ollama_client: Optional[OllamaClientLike] = None) -> None:
        self.config = config or ChatConfig()
        self._ollama_client = ollama_client

        self._sessions: dict[str, ChatSession] = {}
        self._ws: dict[str, WebSocket] = {}
        self._lock = asyncio.Lock()

        self._running = False
        self._cleanup_task: Optional[asyncio.Task] = None

        log.info("ignis_chat_handler_initialized", ollama_host=self.config.ollama_host)

    # ── Lifecycle ───────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._cleanup_task = asyncio.create_task(self._cleanup_loop(), name="ignis_ai_chat_cleanup")
        log.info("ignis_chat_handler_started")

    async def stop(self) -> None:
        self._running = False
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        log.info("ignis_chat_handler_stopped")

    async def _cleanup_loop(self) -> None:
        while self._running:
            await asyncio.sleep(self.config.cleanup_interval_seconds)
            try:
                removed = await self.cleanup_expired_sessions()
                if removed:
                    log.debug("ignis_chat_sessions_cleaned", removed=removed)
            except Exception as exc:
                log.warning("ignis_chat_cleanup_failed", error=str(exc))

    # ── Sessions ────────────────────────────────────────────────────────────

    def create_session(
        self,
        *,
        user_id: Optional[str] = None,
        client_ip: Optional[str] = None,
        user_agent: str = "",
        session_id: Optional[str] = None,
    ) -> ChatSession:
        s = ChatSession(
            session_id=session_id or str(uuid4()),
            user_id=user_id,
            client_ip=client_ip,
            user_agent=user_agent or "",
        )
        self._sessions[s.session_id] = s
        return s

    def get_session(self, session_id: str) -> Optional[ChatSession]:
        return self._sessions.get(session_id)

    def reset_session(self, session_id: str) -> bool:
        s = self._sessions.get(session_id)
        if not s:
            return False
        s.messages.clear()
        s.touch()
        return True

    async def close_session(self, session_id: str) -> None:
        async with self._lock:
            s = self._sessions.get(session_id)
            if s:
                s.closed = True
            ws = self._ws.pop(session_id, None)
            if ws and ws.client_state == WebSocketState.CONNECTED:
                try:
                    await ws.close()
                except Exception:
                    pass
            self._sessions.pop(session_id, None)

    async def cleanup_expired_sessions(self) -> int:
        ttl = self.config.session_ttl_seconds
        expired = [sid for sid, s in self._sessions.items() if s.is_expired(ttl)]
        for sid in expired:
            await self.close_session(sid)
        return len(expired)

    # ── Rate limiting ───────────────────────────────────────────────────────

    def _rate_limit_ok(self, session: ChatSession) -> bool:
        """
        Sliding window simple sur 60s.
        """
        now = time.monotonic()
        cutoff = now - 60.0
        session.req_timestamps = [t for t in session.req_timestamps if t > cutoff]
        if len(session.req_timestamps) >= self.config.max_req_per_minute:
            return False
        session.req_timestamps.append(now)
        return True

    # ── Chat (python API) ───────────────────────────────────────────────────

    async def chat(
        self,
        session_id: str,
        content: str,
        *,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        top_p: Optional[float] = None,
        context: Optional[dict[str, Any]] = None,
        stream: bool = False,
    ) -> Any:
        """
        Mode python:
        - stream=False => retourne str (assistant)
        - stream=True  => retourne async generator[str] de tokens
        """
        if not content or not str(content).strip():
            raise ValueError("Empty content")

        if len(content) > self.config.max_input_chars:
            raise ValueError(f"Content too large (max {self.config.max_input_chars})")

        session = self._sessions.get(session_id) or self.create_session(session_id=session_id)
        if session.closed:
            raise RuntimeError("Session closed")

        if not self._rate_limit_ok(session):
            raise RuntimeError("Rate limited")

        session.append(ChatRole.USER, content)
        session.trim(self.config.max_messages)

        payload = self._build_ollama_payload(
            session=session,
            model=model or self.config.model_default,
            temperature=temperature if temperature is not None else self.config.temperature,
            top_p=top_p if top_p is not None else self.config.top_p,
            context=context,
            stream=stream,
        )

        if not stream:
            data = await self._ollama_chat(payload, stream=False)
            answer = ((data.get("message") or {}) if isinstance(data, dict) else {}).get("content", "")
            session.append(ChatRole.ASSISTANT, answer)
            session.trim(self.config.max_messages)
            return answer

        async def _token_gen() -> AsyncGenerator[str, None]:
            gen = await self._ollama_chat(payload, stream=True)
            buf = []
            async for obj in gen:
                token = ((obj.get("message") or {}) if isinstance(obj, dict) else {}).get("content", "")
                done = bool(obj.get("done", False)) if isinstance(obj, dict) else False
                if token:
                    buf.append(token)
                    yield token
                if done:
                    break
            # persist assistant full message
            answer = "".join(buf).strip()
            if answer:
                session.append(ChatRole.ASSISTANT, answer)
                session.trim(self.config.max_messages)

        return _token_gen()

    def _build_ollama_payload(
        self,
        *,
        session: ChatSession,
        model: str,
        temperature: float,
        top_p: float,
        context: Optional[dict[str, Any]],
        stream: bool,
    ) -> dict[str, Any]:
        # Inject system prompt + optional context block
        sys = self.config.system_prompt.strip()
        if context:
            try:
                ctx = json.dumps(context, ensure_ascii=False, default=str)
            except Exception:
                ctx = str(context)
            sys = sys + "\n\n" + "=== CONTEXTE HLZ ===\n" + ctx + "\n=== FIN CONTEXTE ==="

        messages = [{"role": "system", "content": sys}]
        messages += [m.to_ollama() for m in session.messages]

        return {
            "model": model,
            "messages": messages,
            "stream": bool(stream),
            "options": {
                "temperature": float(temperature),
                "top_p": float(top_p),
                "num_ctx": int(self.config.num_ctx),
            },
        }

    async def _ollama_chat(self, payload: dict[str, Any], *, stream: bool) -> Any:
        if self._ollama_client is not None:
            return await self._ollama_client.chat(
                model=payload["model"],
                messages=payload["messages"],
                stream=stream,
                options=payload.get("options", {}),
            )
        return await _ollama_chat_http(host=self.config.ollama_host, payload=payload, stream=stream)

    # ── WebSocket API ───────────────────────────────────────────────────────

    async def connect(self, websocket: WebSocket, *, session_id: Optional[str] = None, user_id: Optional[str] = None) -> str:
        await websocket.accept()

        sid = session_id or str(uuid4())
        client_ip = self._extract_ip(websocket)
        ua = websocket.headers.get("user-agent", "")

        async with self._lock:
            sess = self._sessions.get(sid)
            if sess is None:
                sess = self.create_session(user_id=user_id, client_ip=client_ip, user_agent=ua, session_id=sid)
            self._ws[sid] = websocket

        await websocket.send_json({
            "type": WSChatMessageType.CONNECTED.value,
            "data": {
                "session_id": sid,
                "server_time": int(time.time() * 1000),
                "model_default": self.config.model_default,
                "limits": {
                    "max_messages": self.config.max_messages,
                    "max_input_chars": self.config.max_input_chars,
                    "max_req_per_minute": self.config.max_req_per_minute,
                }
            }
        })

        log.info("ignis_ai_ws_connected", session_id=sid, client_ip=client_ip)
        return sid

    async def handle_connection(self, session_id: str) -> None:
        ws = self._ws.get(session_id)
        if not ws:
            return

        try:
            while ws.client_state == WebSocketState.CONNECTED:
                raw = await ws.receive_text()
                await self._handle_ws_message(session_id, raw)

        except WebSocketDisconnect:
            log.info("ignis_ai_ws_disconnected", session_id=session_id)
        except Exception as exc:
            log.warning("ignis_ai_ws_error", session_id=session_id, error=str(exc))
        finally:
            async with self._lock:
                self._ws.pop(session_id, None)
            # On ne supprime pas forcément la session : elle peut survivre au WS (reconnect)
            s = self._sessions.get(session_id)
            if s:
                s.touch()

    async def _handle_ws_message(self, session_id: str, raw: str) -> None:
        ws = self._ws.get(session_id)
        if not ws or ws.client_state != WebSocketState.CONNECTED:
            return

        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            await ws.send_json({"type": WSChatMessageType.ERROR.value, "data": {"code": "INVALID_JSON"}})
            return

        mtype = str(msg.get("type", "")).lower()
        data = msg.get("data", {}) or {}

        if mtype == WSChatMessageType.PING.value:
            await ws.send_json({"type": WSChatMessageType.PONG.value, "data": {"server_time": int(time.time() * 1000)}})
            return

        if mtype == WSChatMessageType.RESET.value:
            ok = self.reset_session(session_id)
            await ws.send_json({"type": WSChatMessageType.MESSAGE.value, "data": {"reset": ok}})
            return

        if mtype in (WSChatMessageType.HELLO.value,):
            await ws.send_json({"type": WSChatMessageType.MESSAGE.value, "data": {"hello": True}})
            return

        if mtype != WSChatMessageType.CHAT.value:
            await ws.send_json({"type": WSChatMessageType.ERROR.value, "data": {"code": "UNKNOWN_TYPE", "type": mtype}})
            return

        # CHAT
        content = str(data.get("content", "")).strip()
        if not content:
            await ws.send_json({"type": WSChatMessageType.ERROR.value, "data": {"code": "EMPTY_CONTENT"}})
            return

        if len(content) > self.config.max_input_chars:
            await ws.send_json({"type": WSChatMessageType.ERROR.value, "data": {"code": "CONTENT_TOO_LARGE"}})
            return

        stream = bool(data.get("stream", True))
        model = str(data.get("model") or self.config.model_default)
        temperature = float(data.get("temperature", self.config.temperature))
        top_p = float(data.get("top_p", self.config.top_p))
        context = data.get("context", None)

        session = self._sessions.get(session_id) or self.create_session(session_id=session_id)
        if not self._rate_limit_ok(session):
            await ws.send_json({"type": WSChatMessageType.ERROR.value, "data": {"code": "RATE_LIMITED"}})
            return

        # Execute
        try:
            if not stream:
                answer = await self.chat(
                    session_id,
                    content,
                    model=model,
                    temperature=temperature,
                    top_p=top_p,
                    context=context,
                    stream=False,
                )
                await ws.send_json({
                    "type": WSChatMessageType.MESSAGE.value,
                    "data": {"role": "assistant", "content": answer, "model": model},
                })
                await ws.send_json({"type": WSChatMessageType.DONE.value, "data": {"done": True}})
                return

            token_gen = await self.chat(
                session_id,
                content,
                model=model,
                temperature=temperature,
                top_p=top_p,
                context=context,
                stream=True,
            )

            async for tok in token_gen:
                if ws.client_state != WebSocketState.CONNECTED:
                    break
                await ws.send_json({"type": WSChatMessageType.TOKEN.value, "data": {"token": tok}})

            if ws.client_state == WebSocketState.CONNECTED:
                await ws.send_json({"type": WSChatMessageType.DONE.value, "data": {"done": True}})

        except Exception as exc:
            await ws.send_json({"type": WSChatMessageType.ERROR.value, "data": {"code": "CHAT_FAILED", "error": str(exc)}})

    @staticmethod
    def _extract_ip(websocket: WebSocket) -> str:
        forwarded = websocket.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
        if websocket.client:
            return websocket.client.host
        return "unknown"


__all__ = [
    "ChatRole",
    "WSChatMessageType",
    "ChatMessage",
    "ChatConfig",
    "ChatSession",
    "IgnisChatHandler",
]
