"""
main.py — FastAPI entry point IGNIS Platform (HLZ)

Responsabilités :
- Créer l'app FastAPI
- Charger settings
- Monter les routers (/api/v1/...)
- Initialiser le moteur d'alertes + WebSocket manager + Telegram bot
- Exposer endpoints WebSocket (/ws)
- Gérer startup/shutdown (DB init optionnel, messages Telegram, etc.)
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import Optional

import structlog
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __title__, __version__, __description__
from app.config import settings
from app.api import api_router

from app.alerts.alert_engine import alert_engine, AlertChannel
from app.alerts.websocket_manager import ws_manager
from app.alerts.telegram_bot import init_telegram_bot, get_telegram_bot

log = structlog.get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Lifespan (startup/shutdown)
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ────────────────────────────────────────────────────────────
    log.info(
        "ignis_startup",
        app=__title__,
        version=__version__,
        env=getattr(settings, "app_env", "dev"),
        debug=getattr(settings, "debug", False),
    )

    # DB init (optionnel)
    # En prod => Alembic ; en dev => create_all si DB_CREATE_ALL=true
    try:
        from app.db.database import init_db
        create_all = os.getenv("DB_CREATE_ALL", "false").lower() in ("1", "true", "yes", "y")
        await init_db(create_all=create_all)
    except Exception as exc:
        log.warning("db_init_skipped_or_failed", error=str(exc))

    # Start WebSocket manager
    try:
        await ws_manager.start()
    except Exception as exc:
        log.error("ws_manager_start_failed", error=str(exc))

    # Init Telegram bot (si token)
    try:
        token = getattr(settings, "telegram_bot_token", None) or os.getenv("TELEGRAM_BOT_TOKEN")
        telegram_enabled = bool(getattr(settings, "telegram_enabled", True))
        if token and telegram_enabled:
            bot = init_telegram_bot(token=token)
            await bot.start()

            # Optionnel : enregistre des chats depuis ENV (comma-separated)
            # TELEGRAM_CHAT_IDS="-100xxx,12345"
            chat_ids = os.getenv("TELEGRAM_CHAT_IDS", "").strip()
            if chat_ids:
                from app.alerts.telegram_bot import ChatConfig
                for cid in [x.strip() for x in chat_ids.split(",") if x.strip()]:
                    bot.chat_manager.register(ChatConfig(chat_id=cid, name="IGNIS Alerts"))

            # Envoie message de démarrage (silencieux)
            try:
                await bot.send_startup_message()
            except Exception:
                pass

            log.info("telegram_bot_ready")
        else:
            log.info("telegram_bot_disabled_or_missing_token")
    except Exception as exc:
        log.error("telegram_init_failed", error=str(exc))

    # Register alert routing handlers
    try:
        # WebSocket handler
        alert_engine.router.register(AlertChannel.WEBSOCKET, ws_manager.handle_alert)

        # Telegram handler (si bot dispo)
        bot = get_telegram_bot()
        if bot is not None:
            alert_engine.router.register(AlertChannel.TELEGRAM, bot.handle_alert)

        # Start alert engine worker
        await alert_engine.start()
    except Exception as exc:
        log.error("alert_engine_start_failed", error=str(exc))

    yield

    # ── Shutdown ───────────────────────────────────────────────────────────
    log.info("ignis_shutdown_start")

    # Stop alert engine
    try:
        await alert_engine.stop()
    except Exception as exc:
        log.warning("alert_engine_stop_failed", error=str(exc))

    # Stop Telegram bot
    try:
        bot = get_telegram_bot()
        if bot is not None:
            try:
                await bot.send_shutdown_message()
            except Exception:
                pass
            await bot.stop()
    except Exception as exc:
        log.warning("telegram_stop_failed", error=str(exc))

    # Stop WebSocket manager
    try:
        await ws_manager.stop()
    except Exception as exc:
        log.warning("ws_manager_stop_failed", error=str(exc))

    # Close DB
    try:
        from app.db.database import close_db
        await close_db()
    except Exception as exc:
        log.warning("db_close_failed", error=str(exc))

    log.info("ignis_shutdown_done")


# ─────────────────────────────────────────────────────────────────────────────
# App
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title=__title__,
    version=__version__,
    description=__description__,
    debug=getattr(settings, "debug", False),
    lifespan=lifespan,
)

# ── CORS ─────────────────────────────────────────────────────────────────────

if getattr(settings, "cors_enabled", True):
    app.add_middleware(
        CORSMiddleware,
        allow_origins=getattr(settings, "cors_origins", ["*"]),
        allow_credentials=getattr(settings, "cors_allow_credentials", True),
        allow_methods=getattr(settings, "cors_allow_methods", ["*"]),
        allow_headers=getattr(settings, "cors_allow_headers", ["*"]),
    )

# ── Routers ──────────────────────────────────────────────────────────────────
app.include_router(api_router)


# ─────────────────────────────────────────────────────────────────────────────
# Health / root
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
async def root():
    return {
        "name": __title__,
        "version": __version__,
        "env": getattr(settings, "app_env", "dev"),
        "api": "/api/v1",
        "ws": "/ws",
    }


@app.get("/health", include_in_schema=False)
async def health():
    return {
        "ok": True,
        "app": __title__,
        "version": __version__,
        "ws_connections": ws_manager.active_connections,
        "alert_engine": alert_engine.stats,
    }


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket endpoint (alerts/price/setup updates)
# ─────────────────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """
    Endpoint WS principal (frontend).
    Protocol rooms: subscribe/unsubscribe/ping/request_analysis.
    """
    conn_id: Optional[str] = None
    try:
        conn_id = await ws_manager.connect(ws)
        await ws_manager.handle_connection(conn_id)
    except Exception as exc:
        log.warning("ws_endpoint_error", error=str(exc))
        try:
            if ws.client_state.name == "CONNECTED":  # type: ignore
                await ws.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Global exception fallback (optional)
# ─────────────────────────────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def unhandled_exception_handler(_, exc: Exception):
    log.exception("unhandled_exception", error=str(exc))
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal Server Error"},
    )
