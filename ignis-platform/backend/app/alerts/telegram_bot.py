"""
telegram_bot.py — Bot Telegram IGNIS
Envoi d'alertes S&D en temps réel via Telegram Bot API.
Supporte : messages formatés, boutons inline, throttling, retry, multi-chat.
"""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
from uuid import uuid4

import httpx
import structlog

from app.alerts.alert_engine import Alert, AlertPriority, AlertChannel

log = structlog.get_logger(__name__)

# ══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════════════════════

TELEGRAM_API_BASE       = "https://api.telegram.org/bot{token}"
TELEGRAM_SEND_MESSAGE   = "/sendMessage"
TELEGRAM_SEND_PHOTO     = "/sendPhoto"
TELEGRAM_EDIT_MESSAGE   = "/editMessageText"
TELEGRAM_PIN_MESSAGE    = "/pinChatMessage"
TELEGRAM_DELETE_MESSAGE = "/deleteMessage"
TELEGRAM_ANSWER_CALLBACK = "/answerCallbackQuery"

# Limites Telegram
MAX_MESSAGE_LENGTH      = 4096
MAX_CAPTION_LENGTH      = 1024
MAX_BUTTONS_PER_ROW     = 3
MAX_BUTTON_ROWS         = 10

# Throttle global : 30 msg/sec API Telegram, on reste safe à 20
GLOBAL_RATE_LIMIT_PER_SEC = 20
# Par chat : max 1 msg/sec
CHAT_RATE_LIMIT_PER_SEC   = 1

# Retry
MAX_RETRY_ATTEMPTS  = 5
RETRY_BASE_DELAY    = 1.0   # secondes
RETRY_MAX_DELAY     = 32.0  # secondes (backoff exponentiel capé)

# Timeout HTTP
HTTP_CONNECT_TIMEOUT = 10.0
HTTP_READ_TIMEOUT    = 30.0


# ══════════════════════════════════════════════════════════════════════════════
# ENUMS & DATACLASSES
# ══════════════════════════════════════════════════════════════════════════════

class ParseMode(str, Enum):
    MARKDOWN_V2 = "MarkdownV2"
    HTML        = "HTML"
    PLAIN       = ""


class NotificationLevel(str, Enum):
    """Niveau de notification Telegram (buzzing ou silencieux)."""
    LOUD   = "LOUD"    # Notification avec son
    SILENT = "SILENT"  # Notification silencieuse


@dataclass
class InlineButton:
    text:          str
    callback_data: Optional[str] = None
    url:           Optional[str] = None

    def to_dict(self) -> dict:
        btn: dict[str, Any] = {"text": self.text}
        if self.url:
            btn["url"] = self.url
        elif self.callback_data:
            btn["callback_data"] = self.callback_data
        return btn


@dataclass
class InlineKeyboard:
    rows: list[list[InlineButton]] = field(default_factory=list)

    def add_row(self, *buttons: InlineButton) -> "InlineKeyboard":
        self.rows.append(list(buttons))
        return self

    def to_dict(self) -> dict:
        return {
            "inline_keyboard": [
                [btn.to_dict() for btn in row]
                for row in self.rows
            ]
        }


@dataclass
class TelegramMessage:
    """Message prêt à être envoyé via Telegram."""
    id:                 str              = field(default_factory=lambda: str(uuid4()))
    chat_id:            str              = ""
    text:               str              = ""
    parse_mode:         ParseMode        = ParseMode.MARKDOWN_V2
    reply_markup:       Optional[InlineKeyboard] = None
    disable_preview:    bool             = True
    silent:             bool             = False
    pin:                bool             = False
    alert_id:           Optional[str]    = None
    priority:           AlertPriority    = AlertPriority.LOW
    created_at:         datetime         = field(default_factory=lambda: datetime.now(timezone.utc))

    # État d'envoi
    sent:               bool             = False
    sent_at:            Optional[datetime] = None
    telegram_message_id: Optional[int]   = None
    retry_count:        int              = 0
    last_error:         Optional[str]    = None

    def build_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "chat_id":                  self.chat_id,
            "text":                     self._truncate(self.text),
            "disable_web_page_preview": self.disable_preview,
            "disable_notification":     self.silent,
        }
        if self.parse_mode and self.parse_mode != ParseMode.PLAIN:
            payload["parse_mode"] = self.parse_mode.value
        if self.reply_markup:
            payload["reply_markup"] = self.reply_markup.to_dict()
        return payload

    @staticmethod
    def _truncate(text: str, max_len: int = MAX_MESSAGE_LENGTH) -> str:
        if len(text) <= max_len:
            return text
        suffix = "\n\n\\.\\.\\. \\[tronqué\\]"
        return text[: max_len - len(suffix)] + suffix


# ══════════════════════════════════════════════════════════════════════════════
# RATE LIMITER
# ══════════════════════════════════════════════════════════════════════════════

class TelegramRateLimiter:
    """
    Double rate limiting :
    - Global : N messages/seconde toutes chats confondues
    - Par chat : 1 message/seconde max
    """

    def __init__(
        self,
        global_limit: int = GLOBAL_RATE_LIMIT_PER_SEC,
        chat_limit:   int = CHAT_RATE_LIMIT_PER_SEC,
    ) -> None:
        self._global_limit  = global_limit
        self._chat_limit    = chat_limit
        self._global_tokens = float(global_limit)
        self._chat_tokens:  dict[str, float] = defaultdict(lambda: float(chat_limit))
        self._last_refill   = time.monotonic()
        self._chat_last:    dict[str, float] = defaultdict(float)
        self._lock          = asyncio.Lock()

    async def acquire(self, chat_id: str) -> None:
        """Attend jusqu'à ce qu'un slot soit disponible."""
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_refill

            # Refill global tokens
            self._global_tokens = min(
                float(self._global_limit),
                self._global_tokens + elapsed * self._global_limit,
            )
            # Refill chat tokens
            chat_elapsed = now - self._chat_last.get(chat_id, now)
            self._chat_tokens[chat_id] = min(
                float(self._chat_limit),
                self._chat_tokens[chat_id] + chat_elapsed * self._chat_limit,
            )
            self._last_refill         = now
            self._chat_last[chat_id]  = now

            # Attend si pas de token disponible
            global_wait = 0.0
            chat_wait   = 0.0

            if self._global_tokens < 1.0:
                global_wait = (1.0 - self._global_tokens) / self._global_limit
            if self._chat_tokens[chat_id] < 1.0:
                chat_wait = (1.0 - self._chat_tokens[chat_id]) / self._chat_limit

            wait = max(global_wait, chat_wait)
            if wait > 0:
                log.debug("telegram_rate_limit_wait", chat_id=chat_id, wait_s=round(wait, 3))

        if wait > 0:
            await asyncio.sleep(wait)

        async with self._lock:
            self._global_tokens          -= 1.0
            self._chat_tokens[chat_id]   -= 1.0


# ══════════════════════════════════════════════════════════════════════════════
# BUILDER DE MESSAGES TELEGRAM IGNIS
# ══════════════════════════════════════════════════════════════════════════════

class IgnisTelegramFormatter:
    """
    Construit les messages Telegram MarkdownV2 enrichis pour chaque type d'alerte.
    Ajoute les boutons inline (voir sur chart, ignorer, etc.).
    """

    FRONTEND_BASE_URL = "https://ignis.trade"   # configurable

    @classmethod
    def format(cls, alert: Alert, chat_id: str) -> TelegramMessage:
        text    = cls._build_text(alert)
        markup  = cls._build_keyboard(alert)
        silent  = alert.priority in (AlertPriority.LOW, AlertPriority.MEDIUM)
        pin     = alert.priority == AlertPriority.CRITICAL

        return TelegramMessage(
            chat_id        = chat_id,
            text           = text,
            parse_mode     = ParseMode.MARKDOWN_V2,
            reply_markup   = markup,
            silent         = silent,
            pin            = pin,
            alert_id       = alert.id,
            priority       = alert.priority,
        )

    @classmethod
    def _build_text(cls, alert: Alert) -> str:
        p = alert.payload
        lines: list[str] = []

        # ── Header ────────────────────────────────────────────────────────────
        priority_badge = {
            AlertPriority.CRITICAL: "🔴 *CRITIQUE*",
            AlertPriority.HIGH:     "🟠 *HAUTE*",
            AlertPriority.MEDIUM:   "🟡 *MOYENNE*",
            AlertPriority.LOW:      "⚪ *BASSE*",
        }.get(alert.priority, "⚪")

        lines += [
            f"{alert.emoji} *{cls._e(alert.title)}*",
            f"",
            f"🏷 Priorité : {priority_badge}",
            f"📍 Actif : `{cls._e(alert.symbol)}`  \\|  ⏱ TF : `{cls._e(alert.timeframe)}`",
            f"🕐 `{alert.created_at.strftime('%d/%m/%Y %H:%M UTC')}`",
            f"",
            f"━━━━━━━━━━━━━━━━━━━━",
            f"",
            cls._e(alert.message),
            f"",
        ]

        # ── Bloc Zone ─────────────────────────────────────────────────────────
        if "zone_top" in p and "zone_bot" in p:
            lines += [
                f"━━━━━━━━━━━━━━━━━━━━",
                f"📦 *Zone S&D*",
                f"  ↑ Top  : `{p['zone_top']:.5f}`",
                f"  ↓ Bot  : `{p['zone_bot']:.5f}`",
                f"  📐 Taille : `{abs(p['zone_top'] - p['zone_bot']):.5f}` pips",
            ]
            if "zone_type" in p:
                zt_label = {
                    "DEMAND":   "🟢 DEMAND",
                    "SUPPLY":   "🔴 SUPPLY",
                    "FLIPPY_D": "🔄 FLIPPY → DEMAND",
                    "FLIPPY_S": "🔄 FLIPPY → SUPPLY",
                    "HIDDEN_D": "🕵️ HIDDEN DEMAND",
                    "HIDDEN_S": "🕵️ HIDDEN SUPPLY",
                }.get(p["zone_type"], p["zone_type"])
                lines.append(f"  🏷 Type  : {cls._e(zt_label)}")
            lines.append("")

        # ── Bloc Base ─────────────────────────────────────────────────────────
        if "base_type" in p:
            lines += [
                f"🧱 *Base* : `{cls._e(p['base_type'])}`",
            ]
            if "base_score" in p:
                lines.append(f"  Score base : `{p['base_score']}/100`")
            lines.append("")

        # ── Bloc Score ────────────────────────────────────────────────────────
        if "score" in p:
            score = p["score"]
            bar   = cls._score_bar(score)
            lines += [
                f"━━━━━━━━━━━━━━━━━━━━",
                f"📊 *Score Global* : `{score}/100`",
                f"  {bar}",
            ]
            if "score_breakdown" in p:
                bd = p["score_breakdown"]
                for k, v in bd.items():
                    lines.append(f"  • {cls._e(k)} : `{v}`")
            lines.append("")

        # ── Bloc SL/TP ────────────────────────────────────────────────────────
        if "sl" in p and "tp" in p:
            rr     = p.get("rr", 0)
            entry  = p.get("entry", None)
            lines += [
                f"━━━━━━━━━━━━━━━━━━━━",
                f"🎯 *Niveaux de trade*",
            ]
            if entry:
                lines.append(f"  📌 Entrée : `{entry:.5f}`")
            lines += [
                f"  🎯 TP     : `{p['tp']:.5f}`",
                f"  🛡 SL     : `{p['sl']:.5f}`",
                f"  ⚖️ RR     : `{rr:.1f}x`",
            ]
            if rr >= 3.0:
                lines.append(f"  🔥 Excellent RR \\!")
            elif rr >= 2.0:
                lines.append(f"  ✅ RR acceptable")
            else:
                lines.append(f"  ⚠️ RR faible")
            lines.append("")

        # ── Bloc Setup ────────────────────────────────────────────────────────
        if "setup_status" in p:
            status_fmt = {
                "VALID":   "✅ VALIDÉ",
                "PENDING": "⏳ EN COURS",
                "INVALID": "❌ INVALIDE",
                "WATCH":   "👀 SURVEILLANCE",
                "EXPIRED": "💨 EXPIRÉ",
            }
            st = p["setup_status"]
            lines += [
                f"━━━━━━━━━━━━━━━━━━━━",
                f"🏁 *Statut Setup* : {cls._e(status_fmt.get(st, st))}",
            ]
            checklist = p.get("checklist", {})
            if checklist:
                for item, ok in checklist.items():
                    icon = "✅" if ok else "❌"
                    lines.append(f"  {icon} {cls._e(item)}")
            lines.append("")

        # ── Bloc PA ───────────────────────────────────────────────────────────
        if "pa_pattern" in p and p["pa_pattern"] not in ("NONE", "", None):
            pa_names = {
                "ACCU":         "Accumulation \\(ACCU\\)",
                "THREE_DRIVES": "🚀 Three Drives \\(MAX\\)",
                "FTL":          "Flip Trend Line \\(FTL\\)",
                "PATTERN_69":   "Pattern 69",
                "HIDDEN_SDE":   "Hidden SDE \\(FBO\\)",
            }
            pa_label = pa_names.get(p["pa_pattern"], cls._e(p["pa_pattern"]))
            pa_strength = p.get("pa_strength", 0)
            lines += [
                f"━━━━━━━━━━━━━━━━━━━━",
                f"📐 *PA Pattern* : {pa_label}",
                f"  Force : `{pa_strength}/100`",
                f"",
            ]

        # ── Bloc Market Structure ─────────────────────────────────────────────
        if "market_phase" in p:
            phase_fmt = {
                "RALLY": "📈 RALLY",
                "DROP":  "📉 DROP",
                "BASE":  "📊 BASE",
                "CHOP":  "〰️ CHOP",
            }
            ph = p["market_phase"]
            lines += [
                f"🔃 *Phase marché* : {cls._e(phase_fmt.get(ph, ph))}",
            ]
            if "swing_structure" in p:
                lines.append(f"  Structure : `{cls._e(p['swing_structure'])}`")
            lines.append("")

        # ── Footer ────────────────────────────────────────────────────────────
        lines += [
            f"━━━━━━━━━━━━━━━━━━━━",
            f"🔥 *IGNIS Platform* \\| Supply & Demand Engine",
            f"🆔 `{cls._e(alert.id[:8])}`",
        ]

        return "\n".join(lines)

    @classmethod
    def _build_keyboard(cls, alert: Alert) -> InlineKeyboard:
        kb  = InlineKeyboard()
        sym = alert.symbol
        tf  = alert.timeframe

        # Bouton 1 : voir sur chart
        chart_url = f"{cls.FRONTEND_BASE_URL}/analysis/{sym}?tf={tf}"
        row1 = [
            InlineButton("📊 Voir Chart", url=chart_url),
        ]

        # Bouton 2 : analyse complète
        analysis_url = f"{cls.FRONTEND_BASE_URL}/analysis/{sym}"
        row1.append(InlineButton("🔍 Analyse", url=analysis_url))

        kb.add_row(*row1)

        # Bouton 3 : actions contextuelles
        row2: list[InlineButton] = []

        if alert.priority in (AlertPriority.CRITICAL, AlertPriority.HIGH):
            row2.append(InlineButton("✅ Pris en compte", callback_data=f"ack:{alert.id}"))
        row2.append(InlineButton("🔕 Ignorer", callback_data=f"dismiss:{alert.id}"))

        if row2:
            kb.add_row(*row2)

        # Bouton Scanner si setup valide
        if alert.alert_type.value == "SETUP_VALID":
            scanner_url = f"{cls.FRONTEND_BASE_URL}/scanner?symbol={sym}"
            kb.add_row(InlineButton("🔥 Ouvrir le Setup", url=scanner_url))

        return kb

    @staticmethod
    def _score_bar(score: int, length: int = 10) -> str:
        """Barre de progression ASCII pour le score."""
        filled  = int(score / 100 * length)
        empty   = length - filled
        bar     = "█" * filled + "░" * empty
        color   = "🟢" if score >= 75 else "🟡" if score >= 50 else "🔴"
        return f"{color} `{bar}` `{score}%`"

    @staticmethod
    def _e(text: str) -> str:
        """Escape MarkdownV2."""
        special = r"\_*[]()~`>#+-=|{}.!"
        return "".join(f"\\{c}" if c in special else c for c in str(text))


# ══════════════════════════════════════════════════════════════════════════════
# GESTIONNAIRE DE CHATS (multi-utilisateurs)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ChatConfig:
    chat_id:             str
    name:                str                = ""
    active:              bool               = True
    min_priority:        AlertPriority      = AlertPriority.MEDIUM
    symbol_whitelist:    set[str]           = field(default_factory=set)   # vide = tout
    timeframe_whitelist: set[str]           = field(default_factory=set)   # vide = tout
    alert_type_blacklist: set[str]          = field(default_factory=set)
    timezone_offset:     int                = 0    # UTC offset en heures
    silent_hours:        tuple[int, int]    = (0, 0)  # (start_h, end_h) UTC, (0,0) = désactivé

    def should_receive(self, alert: Alert) -> bool:
        """Détermine si ce chat doit recevoir l'alerte."""
        if not self.active:
            return False
        # Priorité minimum
        priority_order = [AlertPriority.LOW, AlertPriority.MEDIUM, AlertPriority.HIGH, AlertPriority.CRITICAL]
        if priority_order.index(alert.priority) < priority_order.index(self.min_priority):
            return False
        # Whitelist symboles
        if self.symbol_whitelist and alert.symbol not in self.symbol_whitelist:
            return False
        # Whitelist timeframes
        if self.timeframe_whitelist and alert.timeframe not in self.timeframe_whitelist:
            return False
        # Blacklist types
        if alert.alert_type.value in self.alert_type_blacklist:
            return False
        # Silent hours
        if self.silent_hours != (0, 0):
            now_h = datetime.now(timezone.utc).hour
            s, e  = self.silent_hours
            in_silent = (s <= now_h < e) if s < e else (now_h >= s or now_h < e)
            if in_silent and alert.priority != AlertPriority.CRITICAL:
                return False
        return True


class ChatManager:
    """Gestion des chats Telegram configurés (multi-utilisateurs, multi-groupes)."""

    def __init__(self) -> None:
        self._chats: dict[str, ChatConfig] = {}

    def register(self, config: ChatConfig) -> None:
        self._chats[config.chat_id] = config
        log.info("telegram_chat_registered", chat_id=config.chat_id, name=config.name)

    def unregister(self, chat_id: str) -> None:
        self._chats.pop(chat_id, None)

    def get_recipients(self, alert: Alert) -> list[ChatConfig]:
        """Retourne les chats qui doivent recevoir cette alerte."""
        return [c for c in self._chats.values() if c.should_receive(alert)]

    def get_all(self) -> list[ChatConfig]:
        return list(self._chats.values())

    def update_config(self, chat_id: str, **kwargs) -> bool:
        if chat_id not in self._chats:
            return False
        cfg = self._chats[chat_id]
        for k, v in kwargs.items():
            if hasattr(cfg, k):
                setattr(cfg, k, v)
        return True

    def set_active(self, chat_id: str, active: bool) -> None:
        if chat_id in self._chats:
            self._chats[chat_id].active = active


# ══════════════════════════════════════════════════════════════════════════════
# CLIENT HTTP TELEGRAM
# ══════════════════════════════════════════════════════════════════════════════

class TelegramHTTPClient:
    """Client HTTP bas niveau pour l'API Telegram avec retry exponentiel."""

    def __init__(self, token: str) -> None:
        self._base = TELEGRAM_API_BASE.format(token=token)
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self) -> "TelegramHTTPClient":
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=HTTP_CONNECT_TIMEOUT,
                read=HTTP_READ_TIMEOUT,
                write=10.0,
                pool=5.0,
            ),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
        return self

    async def __aexit__(self, *_) -> None:
        if self._client:
            await self._client.aclose()

    async def post(
        self,
        endpoint:   str,
        payload:    dict[str, Any],
        attempt:    int = 0,
    ) -> dict[str, Any]:
        """POST avec retry exponentiel et gestion des erreurs Telegram."""
        url = self._base + endpoint
        try:
            resp = await self._client.post(url, json=payload)
            data = resp.json()

            if resp.status_code == 200 and data.get("ok"):
                return data.get("result", {})

            # Gestion des erreurs spécifiques Telegram
            err_code = data.get("error_code", 0)
            err_desc = data.get("description", "")

            # 429 Too Many Requests → retry after
            if err_code == 429:
                retry_after = data.get("parameters", {}).get("retry_after", 5)
                log.warning("telegram_rate_limited", retry_after=retry_after)
                await asyncio.sleep(retry_after)
                return await self.post(endpoint, payload, attempt)

            # 400 Bad Request → ne pas retenter (message mal formé)
            if err_code == 400:
                log.error("telegram_bad_request", description=err_desc, payload_keys=list(payload.keys()))
                raise ValueError(f"Telegram 400: {err_desc}")

            # 403 Forbidden → chat bloqué
            if err_code == 403:
                log.error("telegram_forbidden", description=err_desc, chat_id=payload.get("chat_id"))
                raise PermissionError(f"Telegram 403: {err_desc}")

            # Autres erreurs → retry
            raise RuntimeError(f"Telegram API error {err_code}: {err_desc}")

        except (httpx.ConnectError, httpx.ReadTimeout, httpx.WriteTimeout) as exc:
            if attempt >= MAX_RETRY_ATTEMPTS:
                log.error("telegram_http_max_retries", error=str(exc))
                raise
            delay = min(RETRY_BASE_DELAY * (2 ** attempt), RETRY_MAX_DELAY)
            log.warning("telegram_http_retry", attempt=attempt + 1, delay=delay, error=str(exc))
            await asyncio.sleep(delay)
            return await self.post(endpoint, payload, attempt + 1)


# ══════════════════════════════════════════════════════════════════════════════
# BOT PRINCIPAL
# ══════════════════════════════════════════════════════════════════════════════

class IgnisTelegramBot:
    """
    Bot Telegram IGNIS — envoi d'alertes S&D multi-chats.

    Usage :
        bot = IgnisTelegramBot(token="123456:ABC-DEF...")
        bot.chat_manager.register(ChatConfig(chat_id="-1001234567890", name="Ignis Alerts"))
        await bot.start()

        # Handler à injecter dans AlertEngine :
        engine.router.register(AlertChannel.TELEGRAM, bot.handle_alert)
    """

    def __init__(self, token: str) -> None:
        self._token        = token
        self._http         = TelegramHTTPClient(token)
        self._rate_limiter = TelegramRateLimiter()
        self._chat_manager = ChatManager()
        self._formatter    = IgnisTelegramFormatter()
        self._running      = False

        # Suivi des messages envoyés (pour pin/edit)
        # alert_id → {chat_id: telegram_message_id}
        self._sent_messages: dict[str, dict[str, int]] = {}

        # Stats
        self._stats = {
            "messages_sent":    0,
            "messages_failed":  0,
            "messages_pinned":  0,
            "bytes_sent":       0,
        }

        log.info("telegram_bot_initialized")

    @property
    def chat_manager(self) -> ChatManager:
        return self._chat_manager

    @property
    def stats(self) -> dict:
        return dict(self._stats)

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    async def start(self) -> None:
        await self._http.__aenter__()
        self._running = True
        log.info("telegram_bot_started")

    async def stop(self) -> None:
        self._running = False
        await self._http.__aexit__(None, None, None)
        log.info("telegram_bot_stopped", stats=self._stats)

    # ── Handler principal (injecté dans AlertEngine) ───────────────────────────

    async def handle_alert(self, alert: Alert) -> None:
        """
        Handler appelé par AlertEngine pour chaque alerte routée vers Telegram.
        Envoie l'alerte à tous les chats configurés et éligibles.
        """
        recipients = self._chat_manager.get_recipients(alert)
        if not recipients:
            log.debug("telegram_no_recipients", alert_id=alert.id)
            return

        tasks = [
            self._send_to_chat(alert, chat)
            for chat in recipients
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for chat, result in zip(recipients, results):
            if isinstance(result, Exception):
                log.error(
                    "telegram_send_failed",
                    chat_id=chat.chat_id,
                    alert_id=alert.id,
                    error=str(result),
                )

    async def _send_to_chat(self, alert: Alert, chat: ChatConfig) -> None:
        """Formate et envoie une alerte vers un chat spécifique."""
        msg = IgnisTelegramFormatter.format(alert, chat.chat_id)

        await self._rate_limiter.acquire(chat.chat_id)

        try:
            result = await self._http.post(
                TELEGRAM_SEND_MESSAGE,
                msg.build_payload(),
            )
            tg_msg_id = result.get("message_id")

            # Tracking
            if alert.id not in self._sent_messages:
                self._sent_messages[alert.id] = {}
            self._sent_messages[alert.id][chat.chat_id] = tg_msg_id

            self._stats["messages_sent"]  += 1
            self._stats["bytes_sent"]     += len(msg.text.encode())

            log.info(
                "telegram_message_sent",
                chat_id=chat.chat_id,
                alert_id=alert.id,
                tg_msg_id=tg_msg_id,
                priority=alert.priority.value,
            )

            # Épingler si CRITICAL
            if msg.pin and tg_msg_id:
                await self._pin_message(chat.chat_id, tg_msg_id)

        except (ValueError, PermissionError) as exc:
            # Erreurs non-retriables
            self._stats["messages_failed"] += 1
            if isinstance(exc, PermissionError):
                # Chat bloqué → désactiver
                self._chat_manager.set_active(chat.chat_id, False)
                log.warning("telegram_chat_deactivated", chat_id=chat.chat_id)
            raise

    # ── Actions Telegram ──────────────────────────────────────────────────────

    async def _pin_message(self, chat_id: str, message_id: int) -> None:
        try:
            await self._http.post(TELEGRAM_PIN_MESSAGE, {
                "chat_id":              chat_id,
                "message_id":           message_id,
                "disable_notification": True,
            })
            self._stats["messages_pinned"] += 1
            log.debug("telegram_message_pinned", chat_id=chat_id, message_id=message_id)
        except Exception as exc:
            log.warning("telegram_pin_failed", error=str(exc))

    async def send_text(
        self,
        chat_id:    str,
        text:       str,
        parse_mode: ParseMode = ParseMode.MARKDOWN_V2,
        silent:     bool      = False,
        keyboard:   Optional[InlineKeyboard] = None,
    ) -> Optional[int]:
        """Envoi manuel d'un message texte brut."""
        await self._rate_limiter.acquire(chat_id)
        msg = TelegramMessage(
            chat_id=chat_id,
            text=text,
            parse_mode=parse_mode,
            silent=silent,
            reply_markup=keyboard,
        )
        try:
            result = await self._http.post(TELEGRAM_SEND_MESSAGE, msg.build_payload())
            return result.get("message_id")
        except Exception as exc:
            log.error("telegram_send_text_failed", chat_id=chat_id, error=str(exc))
            return None

    async def edit_message(
        self,
        chat_id:    str,
        message_id: int,
        new_text:   str,
        parse_mode: ParseMode = ParseMode.MARKDOWN_V2,
    ) -> bool:
        """Édite un message existant."""
        await self._rate_limiter.acquire(chat_id)
        try:
            await self._http.post(TELEGRAM_EDIT_MESSAGE, {
                "chat_id":    chat_id,
                "message_id": message_id,
                "text":       TelegramMessage._truncate(new_text),
                "parse_mode": parse_mode.value,
            })
            return True
        except Exception as exc:
            log.warning("telegram_edit_failed", error=str(exc))
            return False

    async def delete_message(self, chat_id: str, message_id: int) -> bool:
        """Supprime un message."""
        try:
            await self._http.post(TELEGRAM_DELETE_MESSAGE, {
                "chat_id":    chat_id,
                "message_id": message_id,
            })
            return True
        except Exception as exc:
            log.warning("telegram_delete_failed", error=str(exc))
            return False

    async def answer_callback(
        self,
        callback_query_id: str,
        text:              str = "",
        show_alert:        bool = False,
    ) -> None:
        """Répond à un callback inline button."""
        await self._http.post(TELEGRAM_ANSWER_CALLBACK, {
            "callback_query_id": callback_query_id,
            "text":              text,
            "show_alert":        show_alert,
        })

    # ── Notifications spéciales ───────────────────────────────────────────────

    async def send_startup_message(self) -> None:
        """Envoie un message de démarrage à tous les chats."""
        now  = datetime.now(timezone.utc).strftime("%d/%m/%Y %H:%M UTC")
        text = (
            "🔥 *IGNIS Platform démarrée*\n\n"
            f"🕐 `{now}`\n"
            "✅ Moteur S&D actif\n"
            "✅ Alertes Telegram connectées\n"
            "✅ WebSocket en écoute\n\n"
            "Toutes les alertes Supply & Demand seront envoyées ici\\."
        )
        for chat in self._chat_manager.get_all():
            if chat.active:
                await self.send_text(chat.chat_id, text, silent=True)

    async def send_shutdown_message(self) -> None:
        """Envoie un message d'arrêt à tous les chats."""
        text = (
            "⚠️ *IGNIS Platform arrêtée*\n\n"
            "Le moteur d'analyse est hors ligne\\.\n"
            "Les alertes sont suspendues jusqu'au prochain démarrage\\."
        )
        for chat in self._chat_manager.get_all():
            if chat.active:
                await self.send_text(chat.chat_id, text, silent=False)

    async def send_daily_summary(
        self,
        summary: dict[str, Any],
    ) -> None:
        """
        Envoie un résumé quotidien.
        summary : {
            "date": str,
            "setups_valid": int,
            "setups_pending": int,
            "top_symbols": list[str],
            "alerts_sent": int,
        }
        """
        top_syms = "\\, ".join(
            IgnisTelegramFormatter._e(s)
            for s in summary.get("top_symbols", [])[:5]
        )
        text = (
            f"📅 *Résumé du {IgnisTelegramFormatter._e(summary.get('date', ''))}*\n\n"
            f"✅ Setups validés    : `{summary.get('setups_valid', 0)}`\n"
            f"⏳ Setups en cours  : `{summary.get('setups_pending', 0)}`\n"
            f"🔔 Alertes envoyées : `{summary.get('alerts_sent', 0)}`\n\n"
            f"🔥 Top actifs : {top_syms}\n\n"
            f"_Rapport généré par IGNIS Platform_"
        )
        for chat in self._chat_manager.get_all():
            if chat.active:
                await self.send_text(chat.chat_id, text, silent=True)

    # ── Gestion des callbacks inline ──────────────────────────────────────────

    async def handle_callback(self, callback_query: dict[str, Any]) -> None:
        """
        Traite les callbacks des boutons inline.
        À connecter à un webhook ou polling Telegram.
        """
        cq_id   = callback_query.get("id", "")
        data    = callback_query.get("data", "")
        chat_id = str(callback_query.get("message", {}).get("chat", {}).get("id", ""))

        if data.startswith("ack:"):
            alert_id = data[4:]
            log.info("telegram_alert_acknowledged", alert_id=alert_id, chat_id=chat_id)
            await self.answer_callback(cq_id, "✅ Alerte prise en compte", show_alert=False)

        elif data.startswith("dismiss:"):
            alert_id = data[8:]
            log.info("telegram_alert_dismissed", alert_id=alert_id, chat_id=chat_id)
            await self.answer_callback(cq_id, "🔕 Alerte ignorée", show_alert=False)

        else:
            await self.answer_callback(cq_id, "Action inconnue")


# ══════════════════════════════════════════════════════════════════════════════
# INSTANCE SINGLETON
# ══════════════════════════════════════════════════════════════════════════════

_bot_instance: Optional[IgnisTelegramBot] = None


def get_telegram_bot() -> Optional[IgnisTelegramBot]:
    return _bot_instance


def init_telegram_bot(token: str) -> IgnisTelegramBot:
    """Initialise le bot singleton — appelé depuis main.py au démarrage."""
    global _bot_instance
    _bot_instance = IgnisTelegramBot(token=token)
    return _bot_instance
