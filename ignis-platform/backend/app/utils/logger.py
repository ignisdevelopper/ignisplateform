"""
utils/logger.py — Logging helper IGNIS
Expose get_logger(name) basé sur structlog.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import structlog


def _configure_once() -> None:
    # configure stdlib logging
    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    logging.basicConfig(
        level=level,
        format="%(message)s",
    )

    # configure structlog
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer()
            if os.getenv("LOG_JSON", "false").lower() in ("1", "true", "yes", "y")
            else structlog.dev.ConsoleRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


_configured = False


def get_logger(name: str | None = None) -> Any:
    global _configured
    if not _configured:
        _configure_once()
        _configured = True
    return structlog.get_logger(name)
