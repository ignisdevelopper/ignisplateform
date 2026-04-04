"""
config.py — Settings & env vars IGNIS Platform (HLZ)

Rôle :
- Centraliser la configuration runtime (ENV) :
  • FastAPI (host/port, CORS, debug)
  • Database (PostgreSQL/SQLite/Supabase)
  • Redis / Cache
  • WebSocket
  • Telegram Bot
  • Ollama (Ignis AI)
  • Feature flags (enable/disable modules)
  • Timeouts / limits

Stack :
- Pydantic Settings (pydantic-settings) si dispo (recommandé)
- Fallback minimal si package absent (ne casse pas l’app)

ENV recommandés (.env) :
  APP_ENV=dev|prod
  DEBUG=true|false
  API_PREFIX=/api/v1

  DATABASE_URL=postgres+asyncpg://...
  REDIS_URL=redis://localhost:6379/0

  TELEGRAM_BOT_TOKEN=...
  OLLAMA_HOST=http://localhost:11434
  OLLAMA_MODEL=llama3.1
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any, Optional

import structlog

log = structlog.get_logger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Optional .env loader (python-dotenv)
# ─────────────────────────────────────────────────────────────────────────────

def _load_dotenv_if_available() -> None:
    """
    Charge .env si python-dotenv est installé.
    Safe: si non installé, ignore.
    """
    try:  # pragma: no cover
        from dotenv import load_dotenv  # type: ignore
        load_dotenv()
        log.debug("dotenv_loaded")
    except Exception:
        pass


_load_dotenv_if_available()

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _env_bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name, "")
    if v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "y", "on")


def _env_int(name: str, default: int) -> int:
    v = os.getenv(name, "")
    if not v:
        return default
    try:
        return int(v)
    except Exception:
        return default


def _env_float(name: str, default: float) -> float:
    v = os.getenv(name, "")
    if not v:
        return default
    try:
        return float(v)
    except Exception:
        return default


def _env_list(name: str, default: Optional[list[str]] = None) -> list[str]:
    v = os.getenv(name, "")
    if not v:
        return list(default or [])
    items = [x.strip() for x in v.split(",") if x.strip()]
    return items


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic Settings (preferred)
# ─────────────────────────────────────────────────────────────────────────────

try:  # pragma: no cover
    from pydantic import Field
    from pydantic_settings import BaseSettings, SettingsConfigDict

    class Settings(BaseSettings):
        """
        Settings IGNIS.
        Toutes les valeurs sont override par ENV.
        """

        model_config = SettingsConfigDict(
            env_file=".env",
            env_file_encoding="utf-8",
            extra="ignore",
        )

        # ── App ────────────────────────────────────────────────────────────
        app_env: str = Field(default=os.getenv("APP_ENV", "dev"))
        debug: bool = Field(default=_env_bool("DEBUG", False))
        app_name: str = Field(default=os.getenv("APP_NAME", "IGNIS Platform"))
        api_prefix: str = Field(default=os.getenv("API_PREFIX", "/api/v1"))

        # ── CORS ───────────────────────────────────────────────────────────
        cors_enabled: bool = Field(default=_env_bool("CORS_ENABLED", True))
        cors_origins: list[str] = Field(default_factory=lambda: _env_list("CORS_ORIGINS", ["*"]))
        cors_allow_credentials: bool = Field(default=_env_bool("CORS_ALLOW_CREDENTIALS", True))
        cors_allow_methods: list[str] = Field(default_factory=lambda: _env_list("CORS_ALLOW_METHODS", ["*"]))
        cors_allow_headers: list[str] = Field(default_factory=lambda: _env_list("CORS_ALLOW_HEADERS", ["*"]))

        # ── Security / Auth (placeholder) ─────────────────────────────────
        api_key: Optional[str] = Field(default=os.getenv("IGNIS_API_KEY") or None)

        # ── Database ──────────────────────────────────────────────────────
        database_url: str = Field(default=os.getenv("DATABASE_URL", "") or "")
        sqlite_file: str = Field(default=os.getenv("SQLITE_FILE", "./ignis.db"))
        db_echo: bool = Field(default=_env_bool("DB_ECHO", False))
        db_pool_size: int = Field(default=_env_int("DB_POOL_SIZE", 10))
        db_max_overflow: int = Field(default=_env_int("DB_MAX_OVERFLOW", 20))
        db_pool_timeout: int = Field(default=_env_int("DB_POOL_TIMEOUT", 30))

        # Supabase (optionnel)
        supabase_url: Optional[str] = Field(default=os.getenv("SUPABASE_URL") or None)
        supabase_key: Optional[str] = Field(default=os.getenv("SUPABASE_KEY") or None)

        # ── Redis / Cache ────────────────────────────────────────────────
        cache_namespace: str = Field(default=os.getenv("CACHE_NAMESPACE", "ignis"))
        cache_use_redis: bool = Field(default=_env_bool("CACHE_USE_REDIS", True))
        redis_url: str = Field(default=os.getenv("REDIS_URL", "") or "")
        redis_host: str = Field(default=os.getenv("REDIS_HOST", "localhost"))
        redis_port: int = Field(default=_env_int("REDIS_PORT", 6379))
        redis_db: int = Field(default=_env_int("REDIS_DB", 0))
        redis_password: Optional[str] = Field(default=os.getenv("REDIS_PASSWORD") or None)

        # TTL (secondes)
        cache_candles_ttl: int = Field(default=_env_int("CACHE_CANDLES_TTL", 300))
        cache_analysis_ttl: int = Field(default=_env_int("CACHE_ANALYSIS_TTL", 60))
        cache_setup_ttl: int = Field(default=_env_int("CACHE_SETUP_TTL", 120))
        cache_asset_list_ttl: int = Field(default=_env_int("CACHE_ASSET_LIST_TTL", 3600))

        # ── WebSocket ─────────────────────────────────────────────────────
        ws_ping_interval: int = Field(default=_env_int("WS_PING_INTERVAL", 25))
        ws_ping_timeout: int = Field(default=_env_int("WS_PING_TIMEOUT", 10))
        ws_max_connections: int = Field(default=_env_int("WS_MAX_CONNECTIONS", 500))

        # ── Telegram ──────────────────────────────────────────────────────
        telegram_bot_token: Optional[str] = Field(default=os.getenv("TELEGRAM_BOT_TOKEN") or None)
        telegram_enabled: bool = Field(default=_env_bool("TELEGRAM_ENABLED", True))

        # ── Ollama / Ignis AI ─────────────────────────────────────────────
        ollama_host: str = Field(default=os.getenv("OLLAMA_HOST", "http://localhost:11434"))
        ollama_model: str = Field(default=os.getenv("OLLAMA_MODEL", "llama3.1"))
        ollama_timeout_s: float = Field(default=_env_float("OLLAMA_TIMEOUT_S", 120.0))

        ignis_ai_enabled: bool = Field(default=_env_bool("IGNIS_AI_ENABLED", True))
        ignis_ai_temperature: float = Field(default=_env_float("IGNIS_AI_TEMPERATURE", 0.2))
        ignis_ai_top_p: float = Field(default=_env_float("IGNIS_AI_TOP_P", 0.9))
        ignis_ai_num_ctx: int = Field(default=_env_int("IGNIS_AI_NUM_CTX", 8192))

        # ── Feature Flags (pipeline) ──────────────────────────────────────
        enable_market_structure: bool = Field(default=_env_bool("FF_MARKET_STRUCTURE", True))
        enable_base_engine: bool = Field(default=_env_bool("FF_BASE_ENGINE", True))
        enable_sd_zones: bool = Field(default=_env_bool("FF_SD_ZONES", True))
        enable_pa_patterns: bool = Field(default=_env_bool("FF_PA_PATTERNS", True))
        enable_advanced_patterns: bool = Field(default=_env_bool("FF_ADVANCED_PATTERNS", True))
        enable_decision_points: bool = Field(default=_env_bool("FF_DECISION_POINTS", True))
        enable_sl_tp: bool = Field(default=_env_bool("FF_SL_TP", True))
        enable_pullback_entry: bool = Field(default=_env_bool("FF_PULLBACK_ENTRY", True))

        # ── API limits / timeouts ─────────────────────────────────────────
        max_candles_per_request: int = Field(default=_env_int("MAX_CANDLES_PER_REQUEST", 5000))
        analysis_timeout_seconds: int = Field(default=_env_int("ANALYSIS_TIMEOUT_SECONDS", 30))
        rate_limit_per_minute: int = Field(default=_env_int("RATE_LIMIT_PER_MINUTE", 120))

        # ── Logging ───────────────────────────────────────────────────────
        log_level: str = Field(default=os.getenv("LOG_LEVEL", "INFO"))
        log_json: bool = Field(default=_env_bool("LOG_JSON", False))

        # ── Convenience ───────────────────────────────────────────────────
        @property
        def is_prod(self) -> bool:
            return self.app_env.lower() in ("prod", "production")

        @property
        def resolved_database_url(self) -> str:
            """
            Retourne database_url si défini, sinon sqlite async.
            """
            if self.database_url:
                return self.database_url
            # default sqlite async (compatible app/db/database.py)
            file = self.sqlite_file.strip() or "./ignis.db"
            if file.startswith("./"):
                file = file[2:]
            return f"sqlite+aiosqlite:///{file}"

    @lru_cache(maxsize=1)
    def get_settings() -> Settings:
        s = Settings()
        log.info(
            "settings_loaded",
            env=s.app_env,
            debug=s.debug,
            cors=len(s.cors_origins),
            redis_enabled=s.cache_use_redis,
            telegram_enabled=bool(s.telegram_bot_token) and s.telegram_enabled,
            ignis_ai_enabled=s.ignis_ai_enabled,
        )
        return s

except Exception:  # pragma: no cover
    # ─────────────────────────────────────────────────────────────────────────
    # Fallback minimal (sans pydantic-settings)
    # ─────────────────────────────────────────────────────────────────────────
    class Settings:  # type: ignore
        def __init__(self) -> None:
            self.app_env = os.getenv("APP_ENV", "dev")
            self.debug = _env_bool("DEBUG", False)
            self.app_name = os.getenv("APP_NAME", "IGNIS Platform")
            self.api_prefix = os.getenv("API_PREFIX", "/api/v1")

            self.cors_enabled = _env_bool("CORS_ENABLED", True)
            self.cors_origins = _env_list("CORS_ORIGINS", ["*"])
            self.cors_allow_credentials = _env_bool("CORS_ALLOW_CREDENTIALS", True)
            self.cors_allow_methods = _env_list("CORS_ALLOW_METHODS", ["*"])
            self.cors_allow_headers = _env_list("CORS_ALLOW_HEADERS", ["*"])

            self.api_key = os.getenv("IGNIS_API_KEY") or None

            self.database_url = os.getenv("DATABASE_URL", "") or ""
            self.sqlite_file = os.getenv("SQLITE_FILE", "./ignis.db")
            self.db_echo = _env_bool("DB_ECHO", False)
            self.db_pool_size = _env_int("DB_POOL_SIZE", 10)
            self.db_max_overflow = _env_int("DB_MAX_OVERFLOW", 20)
            self.db_pool_timeout = _env_int("DB_POOL_TIMEOUT", 30)

            self.supabase_url = os.getenv("SUPABASE_URL") or None
            self.supabase_key = os.getenv("SUPABASE_KEY") or None

            self.cache_namespace = os.getenv("CACHE_NAMESPACE", "ignis")
            self.cache_use_redis = _env_bool("CACHE_USE_REDIS", True)
            self.redis_url = os.getenv("REDIS_URL", "") or ""
            self.redis_host = os.getenv("REDIS_HOST", "localhost")
            self.redis_port = _env_int("REDIS_PORT", 6379)
            self.redis_db = _env_int("REDIS_DB", 0)
            self.redis_password = os.getenv("REDIS_PASSWORD") or None

            self.cache_candles_ttl = _env_int("CACHE_CANDLES_TTL", 300)
            self.cache_analysis_ttl = _env_int("CACHE_ANALYSIS_TTL", 60)
            self.cache_setup_ttl = _env_int("CACHE_SETUP_TTL", 120)
            self.cache_asset_list_ttl = _env_int("CACHE_ASSET_LIST_TTL", 3600)

            self.ws_ping_interval = _env_int("WS_PING_INTERVAL", 25)
            self.ws_ping_timeout = _env_int("WS_PING_TIMEOUT", 10)
            self.ws_max_connections = _env_int("WS_MAX_CONNECTIONS", 500)

            self.telegram_bot_token = os.getenv("TELEGRAM_BOT_TOKEN") or None
            self.telegram_enabled = _env_bool("TELEGRAM_ENABLED", True)

            self.ollama_host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
            self.ollama_model = os.getenv("OLLAMA_MODEL", "llama3.1")
            self.ollama_timeout_s = _env_float("OLLAMA_TIMEOUT_S", 120.0)

            self.ignis_ai_enabled = _env_bool("IGNIS_AI_ENABLED", True)
            self.ignis_ai_temperature = _env_float("IGNIS_AI_TEMPERATURE", 0.2)
            self.ignis_ai_top_p = _env_float("IGNIS_AI_TOP_P", 0.9)
            self.ignis_ai_num_ctx = _env_int("IGNIS_AI_NUM_CTX", 8192)

            self.enable_market_structure = _env_bool("FF_MARKET_STRUCTURE", True)
            self.enable_base_engine = _env_bool("FF_BASE_ENGINE", True)
            self.enable_sd_zones = _env_bool("FF_SD_ZONES", True)
            self.enable_pa_patterns = _env_bool("FF_PA_PATTERNS", True)
            self.enable_advanced_patterns = _env_bool("FF_ADVANCED_PATTERNS", True)
            self.enable_decision_points = _env_bool("FF_DECISION_POINTS", True)
            self.enable_sl_tp = _env_bool("FF_SL_TP", True)
            self.enable_pullback_entry = _env_bool("FF_PULLBACK_ENTRY", True)

            self.max_candles_per_request = _env_int("MAX_CANDLES_PER_REQUEST", 5000)
            self.analysis_timeout_seconds = _env_int("ANALYSIS_TIMEOUT_SECONDS", 30)
            self.rate_limit_per_minute = _env_int("RATE_LIMIT_PER_MINUTE", 120)

            self.log_level = os.getenv("LOG_LEVEL", "INFO")
            self.log_json = _env_bool("LOG_JSON", False)

        @property
        def is_prod(self) -> bool:
            return self.app_env.lower() in ("prod", "production")

        @property
        def resolved_database_url(self) -> str:
            if self.database_url:
                return self.database_url
            file = (self.sqlite_file or "./ignis.db").strip()
            if file.startswith("./"):
                file = file[2:]
            return f"sqlite+aiosqlite:///{file}"

    _SETTINGS: Optional[Settings] = None

    def get_settings() -> Settings:  # type: ignore
        global _SETTINGS
        if _SETTINGS is None:
            _SETTINGS = Settings()
            log.info("settings_loaded_fallback", env=_SETTINGS.app_env, debug=_SETTINGS.debug)
        return _SETTINGS


# Singleton pratique
settings = get_settings()

__all__ = ["Settings", "get_settings", "settings"]
