"""
db/database.py — SQLAlchemy Async DB (IGNIS)

Support :
- PostgreSQL (asyncpg) via DATABASE_URL
- SQLite (aiosqlite) fallback local

Expose :
- async_engine
- AsyncSessionLocal (sessionmaker)
- get_db() : dépendance FastAPI (yield AsyncSession)
- init_db() : create_all (dev only)
- close_db() : dispose engine

ENV :
- DATABASE_URL : ex
    postgres+asyncpg://user:pass@host:5432/dbname
    sqlite+aiosqlite:///./ignis.db
- DB_ECHO=true|false
- DB_POOL_SIZE, DB_MAX_OVERFLOW, DB_POOL_TIMEOUT
"""

from __future__ import annotations

import os
from typing import AsyncGenerator, Optional

import structlog
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

log = structlog.get_logger(__name__)

# ── Env ──────────────────────────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

DB_ECHO = os.getenv("DB_ECHO", "false").lower() in ("1", "true", "yes", "y")
DB_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "10"))
DB_MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "20"))
DB_POOL_TIMEOUT = int(os.getenv("DB_POOL_TIMEOUT", "30"))

# SQLite default file (dev)
SQLITE_FILE = os.getenv("SQLITE_FILE", "./ignis.db").strip()


def _default_db_url() -> str:
    if DATABASE_URL:
        return DATABASE_URL

    # default to sqlite async
    # NOTE: triple slash means relative path; four for absolute. Keep relative for docker/dev.
    return f"sqlite+aiosqlite:///{SQLITE_FILE.lstrip('./')}" if SQLITE_FILE.startswith("./") else f"sqlite+aiosqlite:///{SQLITE_FILE}"


def _is_sqlite(url: str) -> bool:
    return url.lower().startswith("sqlite")


def _create_engine(url: str) -> AsyncEngine:
    """
    Crée l'engine async.
    - SQLite: NullPool recommandé (aiosqlite + file locks)
    - Postgres: pool configuré
    """
    if _is_sqlite(url):
        return create_async_engine(
            url,
            echo=DB_ECHO,
            poolclass=NullPool,
            connect_args={"check_same_thread": False},
        )

    return create_async_engine(
        url,
        echo=DB_ECHO,
        pool_size=DB_POOL_SIZE,
        max_overflow=DB_MAX_OVERFLOW,
        pool_timeout=DB_POOL_TIMEOUT,
        pool_pre_ping=True,
    )


# ── Engine / Session ─────────────────────────────────────────────────────────

async_engine: AsyncEngine = _create_engine(_default_db_url())

AsyncSessionLocal = async_sessionmaker(
    bind=async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
    autocommit=False,
)


# ── Dependency FastAPI ───────────────────────────────────────────────────────

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    Dépendance FastAPI:
        async def endpoint(db: AsyncSession = Depends(get_db)):
            ...
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            # session close handled by context manager
            pass


# ── Lifecycle helpers (dev / scripts) ────────────────────────────────────────

async def init_db(create_all: bool = False) -> None:
    """
    Initialise la DB.
    - create_all=True: crée les tables (DEV seulement).
      En prod : utiliser Alembic.
    """
    try:
        await async_engine.begin()  # warmup connectivity
        log.info("db_engine_ready", url=str(async_engine.url).split("@")[-1])
    except Exception as exc:
        log.error("db_engine_connect_failed", error=str(exc))
        raise

    if not create_all:
        return

    # lazy import to avoid circular import at startup
    try:
        from app.db.models import Base  # type: ignore
    except Exception as exc:
        log.error("db_models_import_failed", error=str(exc))
        raise

    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    log.warning("db_create_all_done", note="Use Alembic in production.")


async def close_db() -> None:
    """Dispose engine (shutdown)."""
    try:
        await async_engine.dispose()
        log.info("db_engine_disposed")
    except Exception as exc:
        log.warning("db_engine_dispose_failed", error=str(exc))
