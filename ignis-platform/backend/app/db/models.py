"""
db/models.py — SQLAlchemy ORM models (IGNIS)

Objectif :
- Fournir les modèles DB principaux :
  • Candle (optionnel, stockage OHLCV)
  • AlertRecord (persistance alertes)
  • JournalEntry (journal de trades)
  • TelegramChat (config chats)
  • PriceAlert (alertes de prix utilisateur)
  • Asset (watchlist / actifs suivis)

Notes :
- Compatible PostgreSQL et SQLite.
- JSON : utilise JSONB si PostgreSQL dispo, sinon JSON standard.
- Tous les IDs sont des UUID en string (compatible partout).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import JSON

try:  # pragma: no cover
    from sqlalchemy.dialects.postgresql import JSONB  # type: ignore
    JSONType = JSONB
except Exception:  # pragma: no cover
    JSONType = JSON


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


# ═════════════════════════════════════════════════════════════════════════════=
# CANDLES (optionnel)
# ═════════════════════════════════════════════════════════════════════════════=

class Candle(Base):
    """
    Stockage OHLCV (optionnel).

    Conventions :
    - open_time / close_time : epoch ms (UTC)
    - timeframe : "M15", "H1", "H4", ...
    """
    __tablename__ = "candles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    symbol: Mapped[str] = mapped_column(String(32), index=True)
    timeframe: Mapped[str] = mapped_column(String(10), index=True)

    open_time: Mapped[int] = mapped_column(Integer, index=True)   # ms
    close_time: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float, default=0.0)

    source: Mapped[str] = mapped_column(String(32), default="unknown")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc)

    __table_args__ = (
        UniqueConstraint("symbol", "timeframe", "open_time", name="uq_candle_symbol_tf_open_time"),
        Index("ix_candle_symbol_tf_time", "symbol", "timeframe", "open_time"),
    )


# ═════════════════════════════════════════════════════════════════════════════=
# ALERTS (persistance)
# ═════════════════════════════════════════════════════════════════════════════=

class AlertRecord(Base):
    """
    Persistance des alertes envoyées (ou suppressées) pour historique durable.
    """
    __tablename__ = "alerts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # uuid str

    alert_type: Mapped[str] = mapped_column(String(64), index=True)
    priority: Mapped[str] = mapped_column(String(16), index=True)

    symbol: Mapped[str] = mapped_column(String(32), index=True)
    timeframe: Mapped[str] = mapped_column(String(10), index=True)

    title: Mapped[str] = mapped_column(String(256), default="")
    message: Mapped[str] = mapped_column(Text, default="")
    emoji: Mapped[str] = mapped_column(String(16), default="")

    payload: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)
    channels: Mapped[list[str]] = mapped_column(JSONType, default=list)

    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)

    dedup_key: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc, index=True)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_alert_symbol_type_time", "symbol", "alert_type", "created_at"),
    )


# ═════════════════════════════════════════════════════════════════════════════=
# JOURNAL
# ═════════════════════════════════════════════════════════════════════════════=

class JournalEntry(Base):
    """
    Journal de trade (CRUD via routes_journal.py).
    """
    __tablename__ = "journal_entries"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # uuid str

    symbol: Mapped[str] = mapped_column(String(32), index=True)
    timeframe: Mapped[str] = mapped_column(String(10), default="H4", index=True)

    side: Mapped[str] = mapped_column(String(8))  # LONG | SHORT
    status: Mapped[str] = mapped_column(String(16), default="OPEN", index=True)  # OPEN/CLOSED/...

    entry: Mapped[float] = mapped_column(Float)
    sl: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    tp: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    rr: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    size: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    setup_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    setup_score: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    opened_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    exit_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    pnl: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    pnl_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    notes: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list[str]] = mapped_column(JSONType, default=list)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc, onupdate=_now_utc, index=True)

    __table_args__ = (
        Index("ix_journal_symbol_status_time", "symbol", "status", "created_at"),
    )


# ═════════════════════════════════════════════════════════════════════════════=
# TELEGRAM CHATS (config)
# ═════════════════════════════════════════════════════════════════════════════=

class TelegramChat(Base):
    """
    Configuration persistante des chats Telegram (groupes / users).

    Remarque :
    - Le runtime bot (ChatManager) peut charger ces configs au démarrage.
    """
    __tablename__ = "telegram_chats"

    chat_id: Mapped[str] = mapped_column(String(64), primary_key=True)  # Telegram chat id (string)

    name: Mapped[str] = mapped_column(String(128), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    min_priority: Mapped[str] = mapped_column(String(16), default="MEDIUM")  # LOW/MEDIUM/HIGH/CRITICAL

    symbol_whitelist: Mapped[list[str]] = mapped_column(JSONType, default=list)
    timeframe_whitelist: Mapped[list[str]] = mapped_column(JSONType, default=list)
    alert_type_blacklist: Mapped[list[str]] = mapped_column(JSONType, default=list)

    silent_hours_start: Mapped[int] = mapped_column(Integer, default=0)
    silent_hours_end: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc, onupdate=_now_utc)


# ═════════════════════════════════════════════════════════════════════════════=
# PRICE ALERTS (user)
# ═════════════════════════════════════════════════════════════════════════════=

class PriceAlert(Base):
    """
    Alertes de prix simples (au-dessus / en-dessous d’un seuil).
    """
    __tablename__ = "price_alerts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # uuid str

    symbol: Mapped[str] = mapped_column(String(32), index=True)
    threshold: Mapped[float] = mapped_column(Float)
    direction: Mapped[str] = mapped_column(String(8))  # above | below

    label: Mapped[str] = mapped_column(String(128), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc, index=True)

    __table_args__ = (
        Index("ix_price_alert_symbol_active", "symbol", "active"),
    )


# ═════════════════════════════════════════════════════════════════════════════=
# ASSETS (watchlist / catalogue)
# ═════════════════════════════════════════════════════════════════════════════=

class Asset(Base):
    """
    Catalogue / watchlist d’actifs.
    """
    __tablename__ = "assets"

    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)

    asset_class: Mapped[str] = mapped_column(String(16), default="CRYPTO", index=True)  # CRYPTO/FOREX/...
    name: Mapped[str] = mapped_column(String(128), default="")
    exchange: Mapped[str] = mapped_column(String(64), default="")

    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)

    last_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_analysis_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc, onupdate=_now_utc)


__all__ = [
    "Base",
    "Candle",
    "AlertRecord",
    "JournalEntry",
    "TelegramChat",
    "PriceAlert",
    "Asset",
]
