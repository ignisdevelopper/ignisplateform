"""
data/cache_manager.py — Cache Manager IGNIS (Redis + fallback mémoire)

Objectif :
- Fournir une API cache unique async :
    await cache.get(key)
    await cache.set(key, value, ttl=60)
    await cache.delete(key)

- Backend principal : Redis (si dispo + reachable)
- Fallback : cache mémoire (TTL) partagé (process-local)

Notes :
- Les values sont stockées en Redis en JSON (utf-8) si ce n'est pas déjà str/bytes.
- get() tente de décoder JSON automatiquement.
- Tolérant : si Redis down => fallback mémoire sans casser le pipeline.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

import structlog

log = structlog.get_logger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Optional fast json
# ─────────────────────────────────────────────────────────────────────────────

try:  # pragma: no cover
    import orjson  # type: ignore

    def _dumps(v: Any) -> bytes:
        return orjson.dumps(v, option=orjson.OPT_NON_STR_KEYS)

    def _loads(b: bytes) -> Any:
        return orjson.loads(b)

except Exception:  # pragma: no cover
    def _dumps(v: Any) -> bytes:
        return json.dumps(v, default=str, ensure_ascii=False).encode("utf-8")

    def _loads(b: bytes) -> Any:
        return json.loads(b.decode("utf-8"))


# ─────────────────────────────────────────────────────────────────────────────
# Config (env)
# ─────────────────────────────────────────────────────────────────────────────

CACHE_NAMESPACE = os.getenv("CACHE_NAMESPACE", "ignis").strip()
CACHE_USE_REDIS = os.getenv("CACHE_USE_REDIS", "true").lower() in ("1", "true", "yes", "y")

REDIS_URL = os.getenv("REDIS_URL", "").strip()
REDIS_HOST = os.getenv("REDIS_HOST", "localhost").strip()
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
REDIS_DB = int(os.getenv("REDIS_DB", "0"))
REDIS_PASSWORD = os.getenv("REDIS_PASSWORD", "").strip() or None

REDIS_CONNECT_TIMEOUT = float(os.getenv("REDIS_CONNECT_TIMEOUT", "1.5"))
REDIS_SOCKET_TIMEOUT = float(os.getenv("REDIS_SOCKET_TIMEOUT", "2.5"))

# In-memory defaults
MEMORY_MAX_KEYS = int(os.getenv("CACHE_MEMORY_MAX_KEYS", "20000"))


# ─────────────────────────────────────────────────────────────────────────────
# In-memory TTL cache
# ─────────────────────────────────────────────────────────────────────────────

class _MemoryTTLCache:
    """
    Cache mémoire TTL (process-local).
    Stockage: key -> (expire_ts_monotonic, value)
    """

    def __init__(self, max_keys: int = MEMORY_MAX_KEYS) -> None:
        self._store: dict[str, tuple[float, Any]] = {}
        self._lock = asyncio.Lock()
        self._max_keys = max_keys

        self._stats = {
            "hits": 0,
            "miss": 0,
            "sets": 0,
            "deletes": 0,
            "evicted": 0,
            "expired_cleaned": 0,
        }

    def _now(self) -> float:
        return time.monotonic()

    async def get(self, key: str) -> Any:
        now = self._now()
        async with self._lock:
            item = self._store.get(key)
            if not item:
                self._stats["miss"] += 1
                return None
            exp, val = item
            if exp != 0.0 and now >= exp:
                # expired
                self._store.pop(key, None)
                self._stats["miss"] += 1
                self._stats["expired_cleaned"] += 1
                return None

            self._stats["hits"] += 1
            return val

    async def set(self, key: str, value: Any, ttl: int) -> None:
        async with self._lock:
            if len(self._store) >= self._max_keys:
                # simple eviction: remove one expired, else FIFO-ish by popping first
                removed = await self._cleanup_one_locked()
                if not removed and self._store:
                    self._store.pop(next(iter(self._store)))
                    self._stats["evicted"] += 1

            exp = 0.0 if ttl <= 0 else (self._now() + float(ttl))
            self._store[key] = (exp, value)
            self._stats["sets"] += 1

    async def delete(self, key: str) -> bool:
        async with self._lock:
            existed = key in self._store
            self._store.pop(key, None)
            if existed:
                self._stats["deletes"] += 1
            return existed

    async def clear_prefix(self, prefix: str) -> int:
        async with self._lock:
            keys = [k for k in self._store.keys() if k.startswith(prefix)]
            for k in keys:
                self._store.pop(k, None)
            self._stats["deletes"] += len(keys)
            return len(keys)

    async def cleanup(self) -> int:
        async with self._lock:
            return await self._cleanup_all_locked()

    async def _cleanup_one_locked(self) -> bool:
        now = self._now()
        for k, (exp, _) in list(self._store.items()):
            if exp != 0.0 and now >= exp:
                self._store.pop(k, None)
                self._stats["expired_cleaned"] += 1
                return True
        return False

    async def _cleanup_all_locked(self) -> int:
        now = self._now()
        expired = [k for k, (exp, _) in self._store.items() if exp != 0.0 and now >= exp]
        for k in expired:
            self._store.pop(k, None)
        self._stats["expired_cleaned"] += len(expired)
        return len(expired)

    def stats(self) -> dict[str, Any]:
        return {
            **self._stats,
            "keys": len(self._store),
            "max_keys": self._max_keys,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Redis backend (optional)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _RedisState:
    enabled: bool
    url: str


class CacheManager:
    """
    CacheManager async :
    - Tente Redis si activé
    - Fallback mémoire

    Usage :
        cache = CacheManager()
        await cache.set("analysis:BTCUSDT:H4:500", result_dict, ttl=60)
        v = await cache.get(...)
    """

    # Shared backend across instances
    _mem = _MemoryTTLCache()
    _redis_client = None
    _redis_lock = asyncio.Lock()
    _redis_state = _RedisState(enabled=CACHE_USE_REDIS, url=REDIS_URL)

    def __init__(self, namespace: str = CACHE_NAMESPACE) -> None:
        self._ns = (namespace or "").strip() or "ignis"

    def _k(self, key: str) -> str:
        key = str(key)
        if key.startswith(f"{self._ns}:"):
            return key
        return f"{self._ns}:{key}"

    # ──────────────────────────────────────────────────────────────────────
    # Redis client management
    # ──────────────────────────────────────────────────────────────────────

    async def _get_redis(self):
        if not self._redis_state.enabled:
            return None

        if CacheManager._redis_client is not None:
            return CacheManager._redis_client

        async with CacheManager._redis_lock:
            if CacheManager._redis_client is not None:
                return CacheManager._redis_client

            try:
                import redis.asyncio as redis  # type: ignore
            except Exception as exc:  # pragma: no cover
                log.warning("redis_not_installed_fallback_memory", error=str(exc))
                CacheManager._redis_state = _RedisState(enabled=False, url="")
                return None

            try:
                if REDIS_URL:
                    client = redis.from_url(
                        REDIS_URL,
                        encoding=None,
                        decode_responses=False,
                        socket_connect_timeout=REDIS_CONNECT_TIMEOUT,
                        socket_timeout=REDIS_SOCKET_TIMEOUT,
                    )
                else:
                    client = redis.Redis(
                        host=REDIS_HOST,
                        port=REDIS_PORT,
                        db=REDIS_DB,
                        password=REDIS_PASSWORD,
                        encoding=None,
                        decode_responses=False,
                        socket_connect_timeout=REDIS_CONNECT_TIMEOUT,
                        socket_timeout=REDIS_SOCKET_TIMEOUT,
                    )

                # ping to validate
                await client.ping()
                CacheManager._redis_client = client
                log.info("cache_redis_connected", redis_url=REDIS_URL or f"{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}")
                return CacheManager._redis_client

            except Exception as exc:
                log.warning("cache_redis_unreachable_fallback_memory", error=str(exc))
                CacheManager._redis_state = _RedisState(enabled=False, url="")
                CacheManager._redis_client = None
                return None

    # ──────────────────────────────────────────────────────────────────────
    # Public API
    # ──────────────────────────────────────────────────────────────────────

    async def get(self, key: str) -> Any:
        k = self._k(key)

        r = await self._get_redis()
        if r is not None:
            try:
                raw = await r.get(k)
                if raw is None:
                    return await CacheManager._mem.get(k)

                # bytes -> try json
                if isinstance(raw, (bytes, bytearray)):
                    try:
                        return _loads(bytes(raw))
                    except Exception:
                        # fallback: utf-8 text
                        try:
                            return bytes(raw).decode("utf-8")
                        except Exception:
                            return raw

                # str -> try json
                if isinstance(raw, str):
                    try:
                        return json.loads(raw)
                    except Exception:
                        return raw

                return raw

            except Exception as exc:
                log.debug("cache_redis_get_failed_fallback_memory", key=k, error=str(exc))
                return await CacheManager._mem.get(k)

        return await CacheManager._mem.get(k)

    async def set(self, key: str, value: Any, ttl: int = 60) -> None:
        k = self._k(key)

        r = await self._get_redis()
        if r is not None:
            try:
                # store as bytes (json) unless already bytes/str
                if isinstance(value, (bytes, bytearray)):
                    payload = bytes(value)
                elif isinstance(value, str):
                    payload = value.encode("utf-8")
                else:
                    payload = _dumps(value)

                if ttl and ttl > 0:
                    await r.set(k, payload, ex=int(ttl))
                else:
                    await r.set(k, payload)

                # also warm memory (very short) to reduce roundtrips
                await CacheManager._mem.set(k, value, ttl=min(int(ttl), 5) if ttl and ttl > 0 else 0)
                return

            except Exception as exc:
                log.debug("cache_redis_set_failed_fallback_memory", key=k, error=str(exc))

        await CacheManager._mem.set(k, value, ttl=int(ttl))

    async def delete(self, key: str) -> bool:
        k = self._k(key)
        deleted_any = False

        r = await self._get_redis()
        if r is not None:
            try:
                n = await r.delete(k)
                deleted_any = deleted_any or (int(n) > 0)
            except Exception as exc:
                log.debug("cache_redis_delete_failed", key=k, error=str(exc))

        deleted_any = (await CacheManager._mem.delete(k)) or deleted_any
        return deleted_any

    async def clear_prefix(self, prefix: str) -> int:
        """
        Clear keys by prefix in memory + Redis best-effort via SCAN (safe).
        """
        p = self._k(prefix)
        removed = await CacheManager._mem.clear_prefix(p)

        r = await self._get_redis()
        if r is not None:
            try:
                # Use scan_iter to avoid blocking
                async for k in r.scan_iter(match=f"{p}*"):
                    await r.delete(k)
                    removed += 1
            except Exception as exc:
                log.debug("cache_redis_clear_prefix_failed", prefix=p, error=str(exc))

        return removed

    async def cleanup_memory(self) -> int:
        """Nettoie les expirations du cache mémoire."""
        return await CacheManager._mem.cleanup()

    def stats(self) -> dict[str, Any]:
        """Stats basiques (memory only + redis enabled flag)."""
        return {
            "namespace": self._ns,
            "redis_enabled": CacheManager._redis_state.enabled,
            "memory": CacheManager._mem.stats(),
        }
