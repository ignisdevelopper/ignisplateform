"""
alerts/__init__.py — Package alertes IGNIS
Expose les composants principaux du système d'alertes.
"""

from app.alerts.alert_engine import (
    # Enums
    AlertType,
    AlertPriority,
    AlertChannel,
    AlertStatus,

    # Dataclasses
    AlertEvent,
    Alert,

    # Maps de configuration
    ALERT_PRIORITY_MAP,
    PRIORITY_CHANNELS_MAP,
    ALERT_EMOJI_MAP,
    ALERT_COOLDOWNS,

    # Classes internes
    AlertMessageBuilder,
    DedupManager,
    AlertRouter,
    AlertQueue,

    # Moteur principal
    AlertEngine,
    alert_engine,

    # Helper global
    emit_alert,
)

from app.alerts.telegram_bot import (
    # Enums
    ParseMode,
    NotificationLevel,

    # Dataclasses
    InlineButton,
    InlineKeyboard,
    TelegramMessage,
    ChatConfig,

    # Classes
    TelegramRateLimiter,
    IgnisTelegramFormatter,
    ChatManager,
    TelegramHTTPClient,
    IgnisTelegramBot,

    # Singleton
    get_telegram_bot,
    init_telegram_bot,
)

__all__ = [
    # ── AlertEngine ───────────────────────────────────────────────────────────
    "AlertType",
    "AlertPriority",
    "AlertChannel",
    "AlertStatus",
    "AlertEvent",
    "Alert",
    "ALERT_PRIORITY_MAP",
    "PRIORITY_CHANNELS_MAP",
    "ALERT_EMOJI_MAP",
    "ALERT_COOLDOWNS",
    "AlertMessageBuilder",
    "DedupManager",
    "AlertRouter",
    "AlertQueue",
    "AlertEngine",
    "alert_engine",
    "emit_alert",

    # ── TelegramBot ───────────────────────────────────────────────────────────
    "ParseMode",
    "NotificationLevel",
    "InlineButton",
    "InlineKeyboard",
    "TelegramMessage",
    "ChatConfig",
    "TelegramRateLimiter",
    "IgnisTelegramFormatter",
    "ChatManager",
    "TelegramHTTPClient",
    "IgnisTelegramBot",
    "get_telegram_bot",
    "init_telegram_bot",
]