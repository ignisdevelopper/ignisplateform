"""
alert_engine.py — Moteur de déclenchement d'alertes IGNIS
Règles de déclenchement basées sur les événements S&D en temps réel.
Gère : création, évaluation, déduplication, routing (Telegram + WebSocket).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Callable, Coroutine, Optional
from uuid import uuid4

import structlog

from app import (
    BaseType,
    DPType,
    MarketPhase,
    PAPattern,
    SetupStatus,
    TIMEFRAMES,
    ZoneType,
)

log = structlog.get_logger(__name__)


# ══════════════════════════════════════════════════════════════════════════════
# ENUMS
# ══════════════════════════════════════════════════════════════════════════════

class AlertType(str, Enum):
    # ── Zones S&D ─────────────────────────────────────────────────────────────
    ZONE_SDE_DETECTED        = "ZONE_SDE_DETECTED"         # Nouveau SDE détecté
    ZONE_SGB_CREATED         = "ZONE_SGB_CREATED"          # SGB créé (zone d'entrée)
    ZONE_SDP_VALIDATED       = "ZONE_SDP_VALIDATED"        # SDP validé (HEAD tenu)
    ZONE_FTB_APPROACHING     = "ZONE_FTB_APPROACHING"      # Prix approche FTB
    ZONE_FTB_HIT             = "ZONE_FTB_HIT"              # FTB touché
    ZONE_FLIPPY_DETECTED     = "ZONE_FLIPPY_DETECTED"      # FLIPPY détecté
    ZONE_FAILED_SDE          = "ZONE_FAILED_SDE"           # SDE échoué
    ZONE_INVALIDATED         = "ZONE_INVALIDATED"          # Zone invalidée

    # ── Setup ─────────────────────────────────────────────────────────────────
    SETUP_VALID              = "SETUP_VALID"               # Setup complet validé
    SETUP_PENDING            = "SETUP_PENDING"             # Setup en formation
    SETUP_INVALID            = "SETUP_INVALID"             # Setup invalidé
    SETUP_SCORE_UPGRADED     = "SETUP_SCORE_UPGRADED"      # Score setup monté

    # ── PA Patterns ───────────────────────────────────────────────────────────
    PA_ACCU_DETECTED         = "PA_ACCU_DETECTED"          # Pattern ACCU
    PA_THREE_DRIVES          = "PA_THREE_DRIVES"           # 3 Drives (fort)
    PA_FTL_DETECTED          = "PA_FTL_DETECTED"           # Flip Trend Line
    PA_69_DETECTED           = "PA_69_DETECTED"            # Pattern 69
    PA_HIDDEN_SDE            = "PA_HIDDEN_SDE"             # Hidden SDE

    # ── Market Structure ──────────────────────────────────────────────────────
    STRUCTURE_BREAK          = "STRUCTURE_BREAK"           # Structure Breaker
    STRUCTURE_PHASE_CHANGE   = "STRUCTURE_PHASE_CHANGE"    # Changement de phase
    SWING_NEW_HH             = "SWING_NEW_HH"              # Nouveau Higher High
    SWING_NEW_LL             = "SWING_NEW_LL"              # Nouveau Lower Low

    # ── Decision Point ────────────────────────────────────────────────────────
    DP_PRICE_AT_ZONE         = "DP_PRICE_AT_ZONE"          # Prix sur DP
    DP_KEY_LEVEL_TOUCH       = "DP_KEY_LEVEL_TOUCH"        # Touch Key Level
    SL_TP_UPDATED            = "SL_TP_UPDATED"             # SL/TP recalculé

    # ── Advanced Patterns ─────────────────────────────────────────────────────
    OVER_UNDER_DETECTED      = "OVER_UNDER_DETECTED"       # OU détecté
    IOU_DETECTED             = "IOU_DETECTED"              # Ignored OU
    FLAG_LIMIT_DETECTED      = "FLAG_LIMIT_DETECTED"       # Flag Limit
    COUNTER_ATTACK           = "COUNTER_ATTACK"            # Contre-attaque

    # ── Prix ──────────────────────────────────────────────────────────────────
    PRICE_ALERT_ABOVE        = "PRICE_ALERT_ABOVE"         # Prix > seuil
    PRICE_ALERT_BELOW        = "PRICE_ALERT_BELOW"         # Prix < seuil
    PRICE_ZONE_PROXIMITY     = "PRICE_ZONE_PROXIMITY"      # Prix à X% d'une zone

    # ── Système ───────────────────────────────────────────────────────────────
    ENGINE_ERROR             = "ENGINE_ERROR"              # Erreur interne
    DATA_STALE               = "DATA_STALE"                # Données obsolètes


class AlertPriority(str, Enum):
    CRITICAL = "CRITICAL"   # 🔴 Action immédiate requise
    HIGH     = "HIGH"       # 🟠 Important
    MEDIUM   = "MEDIUM"     # 🟡 Informatif
    LOW      = "LOW"        # ⚪ Log seulement


class AlertChannel(str, Enum):
    TELEGRAM  = "TELEGRAM"
    WEBSOCKET = "WEBSOCKET"
    DATABASE  = "DATABASE"
    LOG       = "LOG"


class AlertStatus(str, Enum):
    PENDING   = "PENDING"
    SENT      = "SENT"
    FAILED    = "FAILED"
    SUPPRESSED = "SUPPRESSED"   # Dédupliqué ou cooldown


# ══════════════════════════════════════════════════════════════════════════════
# MODÈLES DE DONNÉES
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class AlertEvent:
    """Événement brut entrant dans le moteur."""
    alert_type:  AlertType
    symbol:      str                        # ex: "BTCUSDT", "EURUSD"
    timeframe:   str                        # ex: "H4", "D1"
    payload:     dict[str, Any]             # données spécifiques à l'événement
    timestamp:   datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    source:      str      = "ignis_core"    # module source
    event_id:    str      = field(default_factory=lambda: str(uuid4()))


@dataclass
class Alert:
    """Alerte construite et enrichie, prête à être routée."""
    id:            str
    alert_type:    AlertType
    priority:      AlertPriority
    symbol:        str
    timeframe:     str
    title:         str
    message:       str
    emoji:         str
    payload:       dict[str, Any]
    channels:      list[AlertChannel]
    status:        AlertStatus            = AlertStatus.PENDING
    created_at:    datetime               = field(default_factory=lambda: datetime.now(timezone.utc))
    sent_at:       Optional[datetime]     = None
    dedup_key:     str                    = ""
    retry_count:   int                    = 0
    max_retries:   int                    = 3

    def to_dict(self) -> dict[str, Any]:
        return {
            "id":           self.id,
            "alert_type":   self.alert_type.value,
            "priority":     self.priority.value,
            "symbol":       self.symbol,
            "timeframe":    self.timeframe,
            "title":        self.title,
            "message":      self.message,
            "emoji":        self.emoji,
            "payload":      self.payload,
            "channels":     [c.value for c in self.channels],
            "status":       self.status.value,
            "created_at":   self.created_at.isoformat(),
            "sent_at":      self.sent_at.isoformat() if self.sent_at else None,
        }

    def to_telegram_markdown(self) -> str:
        """Format Telegram MarkdownV2."""
        lines = [
            f"{self.emoji} *{self._escape_md(self.title)}*",
            f"",
            f"📍 `{self.symbol}` \\| ⏱ `{self.timeframe}`",
            f"🕐 `{self.created_at.strftime('%Y-%m-%d %H:%M UTC')}`",
            f"",
            self._escape_md(self.message),
        ]
        # Ajouter les champs payload pertinents
        if "score" in self.payload:
            lines.append(f"\n📊 *Score*: `{self.payload['score']}/100`")
        if "zone_top" in self.payload and "zone_bot" in self.payload:
            lines.append(
                f"📦 *Zone*: `{self.payload['zone_bot']:.5f}` — `{self.payload['zone_top']:.5f}`"
            )
        if "sl" in self.payload and "tp" in self.payload:
            rr = self.payload.get("rr", 0)
            lines.append(
                f"🎯 *TP*: `{self.payload['tp']:.5f}` \\| 🛡 *SL*: `{self.payload['sl']:.5f}` \\| RR: `{rr:.1f}`"
            )
        if "setup_status" in self.payload:
            status_map = {
                SetupStatus.VALID:   "✅ VALID",
                SetupStatus.PENDING: "⏳ PENDING",
                SetupStatus.INVALID: "❌ INVALID",
            }
            s = self.payload["setup_status"]
            lines.append(f"\n🏁 *Setup*: {self._escape_md(status_map.get(s, s))}")
        return "\n".join(lines)

    @staticmethod
    def _escape_md(text: str) -> str:
        """Escape les caractères spéciaux Telegram MarkdownV2."""
        special = r"\_*[]()~`>#+-=|{}.!"
        return "".join(f"\\{c}" if c in special else c for c in str(text))

    def to_websocket_payload(self) -> dict[str, Any]:
        """Payload optimisé pour envoi WebSocket frontend."""
        return {
            "type":      "alert",
            "id":        self.id,
            "alertType": self.alert_type.value,
            "priority":  self.priority.value,
            "symbol":    self.symbol,
            "timeframe": self.timeframe,
            "title":     self.title,
            "message":   self.message,
            "emoji":     self.emoji,
            "payload":   self.payload,
            "ts":        int(self.created_at.timestamp() * 1000),
        }


# ══════════════════════════════════════════════════════════════════════════════
# RÈGLES DE PRIORITÉ ET ROUTING
# ══════════════════════════════════════════════════════════════════════════════

# Priorité par type d'alerte
ALERT_PRIORITY_MAP: dict[AlertType, AlertPriority] = {
    AlertType.SETUP_VALID:            AlertPriority.CRITICAL,
    AlertType.ZONE_SDE_DETECTED:      AlertPriority.HIGH,
    AlertType.ZONE_SGB_CREATED:       AlertPriority.HIGH,
    AlertType.ZONE_SDP_VALIDATED:     AlertPriority.HIGH,
    AlertType.ZONE_FTB_HIT:           AlertPriority.CRITICAL,
    AlertType.PA_THREE_DRIVES:        AlertPriority.CRITICAL,
    AlertType.PA_69_DETECTED:         AlertPriority.HIGH,
    AlertType.PA_HIDDEN_SDE:          AlertPriority.HIGH,
    AlertType.PA_ACCU_DETECTED:       AlertPriority.MEDIUM,
    AlertType.PA_FTL_DETECTED:        AlertPriority.MEDIUM,
    AlertType.ZONE_FLIPPY_DETECTED:   AlertPriority.HIGH,
    AlertType.STRUCTURE_BREAK:        AlertPriority.HIGH,
    AlertType.OVER_UNDER_DETECTED:    AlertPriority.HIGH,
    AlertType.IOU_DETECTED:           AlertPriority.CRITICAL,
    AlertType.ZONE_FTB_APPROACHING:   AlertPriority.MEDIUM,
    AlertType.SETUP_PENDING:          AlertPriority.MEDIUM,
    AlertType.SETUP_SCORE_UPGRADED:   AlertPriority.MEDIUM,
    AlertType.STRUCTURE_PHASE_CHANGE: AlertPriority.MEDIUM,
    AlertType.DP_PRICE_AT_ZONE:       AlertPriority.HIGH,
    AlertType.DP_KEY_LEVEL_TOUCH:     AlertPriority.MEDIUM,
    AlertType.FLAG_LIMIT_DETECTED:    AlertPriority.MEDIUM,
    AlertType.COUNTER_ATTACK:         AlertPriority.MEDIUM,
    AlertType.ZONE_FAILED_SDE:        AlertPriority.MEDIUM,
    AlertType.ZONE_INVALIDATED:       AlertPriority.LOW,
    AlertType.SETUP_INVALID:          AlertPriority.LOW,
    AlertType.PRICE_ALERT_ABOVE:      AlertPriority.HIGH,
    AlertType.PRICE_ALERT_BELOW:      AlertPriority.HIGH,
    AlertType.PRICE_ZONE_PROXIMITY:   AlertPriority.MEDIUM,
    AlertType.SWING_NEW_HH:           AlertPriority.LOW,
    AlertType.SWING_NEW_LL:           AlertPriority.LOW,
    AlertType.SL_TP_UPDATED:          AlertPriority.LOW,
    AlertType.ENGINE_ERROR:           AlertPriority.HIGH,
    AlertType.DATA_STALE:             AlertPriority.MEDIUM,
}

# Channels par priorité
PRIORITY_CHANNELS_MAP: dict[AlertPriority, list[AlertChannel]] = {
    AlertPriority.CRITICAL: [
        AlertChannel.TELEGRAM,
        AlertChannel.WEBSOCKET,
        AlertChannel.DATABASE,
    ],
    AlertPriority.HIGH: [
        AlertChannel.TELEGRAM,
        AlertChannel.WEBSOCKET,
        AlertChannel.DATABASE,
    ],
    AlertPriority.MEDIUM: [
        AlertChannel.WEBSOCKET,
        AlertChannel.DATABASE,
    ],
    AlertPriority.LOW: [
        AlertChannel.DATABASE,
        AlertChannel.LOG,
    ],
}

# Emojis par type
ALERT_EMOJI_MAP: dict[AlertType, str] = {
    AlertType.SETUP_VALID:            "🔥",
    AlertType.SETUP_PENDING:          "⏳",
    AlertType.SETUP_INVALID:          "❌",
    AlertType.SETUP_SCORE_UPGRADED:   "📈",
    AlertType.ZONE_SDE_DETECTED:      "⚡",
    AlertType.ZONE_SGB_CREATED:       "📦",
    AlertType.ZONE_SDP_VALIDATED:     "✅",
    AlertType.ZONE_FTB_APPROACHING:   "👀",
    AlertType.ZONE_FTB_HIT:           "🎯",
    AlertType.ZONE_FLIPPY_DETECTED:   "🔄",
    AlertType.ZONE_FAILED_SDE:        "💨",
    AlertType.ZONE_INVALIDATED:       "🚫",
    AlertType.PA_ACCU_DETECTED:       "🪜",
    AlertType.PA_THREE_DRIVES:        "🚀",
    AlertType.PA_FTL_DETECTED:        "📐",
    AlertType.PA_69_DETECTED:         "♾️",
    AlertType.PA_HIDDEN_SDE:          "🕵️",
    AlertType.STRUCTURE_BREAK:        "💥",
    AlertType.STRUCTURE_PHASE_CHANGE: "🔃",
    AlertType.SWING_NEW_HH:           "⬆️",
    AlertType.SWING_NEW_LL:           "⬇️",
    AlertType.DP_PRICE_AT_ZONE:       "📍",
    AlertType.DP_KEY_LEVEL_TOUCH:     "🔑",
    AlertType.SL_TP_UPDATED:          "🛡",
    AlertType.OVER_UNDER_DETECTED:    "🌊",
    AlertType.IOU_DETECTED:           "💎",
    AlertType.FLAG_LIMIT_DETECTED:    "🚩",
    AlertType.COUNTER_ATTACK:         "⚔️",
    AlertType.PRICE_ALERT_ABOVE:      "🟢",
    AlertType.PRICE_ALERT_BELOW:      "🔴",
    AlertType.PRICE_ZONE_PROXIMITY:   "🔔",
    AlertType.ENGINE_ERROR:           "🛑",
    AlertType.DATA_STALE:             "⚠️",
}

# Cooldowns de déduplication en secondes
ALERT_COOLDOWNS: dict[AlertType, int] = {
    AlertType.SETUP_VALID:            300,   # 5 min — pas de spam setup
    AlertType.ZONE_SDE_DETECTED:      120,
    AlertType.ZONE_SGB_CREATED:       120,
    AlertType.ZONE_SDP_VALIDATED:     180,
    AlertType.ZONE_FTB_HIT:           60,
    AlertType.ZONE_FTB_APPROACHING:   300,
    AlertType.ZONE_FLIPPY_DETECTED:   300,
    AlertType.PA_THREE_DRIVES:        300,
    AlertType.PA_69_DETECTED:         180,
    AlertType.STRUCTURE_BREAK:        120,
    AlertType.OVER_UNDER_DETECTED:    180,
    AlertType.IOU_DETECTED:           180,
    AlertType.PRICE_ZONE_PROXIMITY:   600,   # 10 min — éviter le spam de proximité
    AlertType.SWING_NEW_HH:           60,
    AlertType.SWING_NEW_LL:           60,
    AlertType.DATA_STALE:             300,
    AlertType.ENGINE_ERROR:           60,
}


# ══════════════════════════════════════════════════════════════════════════════
# BUILDERS DE MESSAGES
# ══════════════════════════════════════════════════════════════════════════════

class AlertMessageBuilder:
    """Construit le titre et le message lisible pour chaque type d'alerte."""

    @staticmethod
    def build(event: AlertEvent) -> tuple[str, str]:
        """Retourne (title, message) selon le type d'alerte."""
        method_name = f"_build_{event.alert_type.value.lower()}"
        builder = getattr(AlertMessageBuilder, method_name, AlertMessageBuilder._build_generic)
        return builder(event)

    # ── Setups ────────────────────────────────────────────────────────────────
    @staticmethod
    def _build_setup_valid(e: AlertEvent) -> tuple[str, str]:
        p = e.payload
        score = p.get("score", 0)
        pa    = p.get("pa_pattern", PAPattern.NONE)
        tf    = e.timeframe
        title = f"Setup VALID détecté — {e.symbol}"
        msg = (
            f"Un setup Supply & Demand complet a été validé sur {e.symbol} ({tf}).\n"
            f"Tous les critères sont réunis : SB confirmé, SDE englobé, SGB créé, "
            f"SDP tenu, PA {pa} actif et DP aligné.\n"
            f"Score global : {score}/100."
        )
        return title, msg

    @staticmethod
    def _build_setup_pending(e: AlertEvent) -> tuple[str, str]:
        p     = e.payload
        step  = p.get("pending_step", "SGB en attente")
        title = f"Setup en formation — {e.symbol}"
        msg   = (
            f"Setup S&D en cours de formation sur {e.symbol} ({e.timeframe}).\n"
            f"Étape actuelle : {step}.\n"
            f"Surveillez l'évolution du prix vers la zone."
        )
        return title, msg

    @staticmethod
    def _build_setup_invalid(e: AlertEvent) -> tuple[str, str]:
        reason = e.payload.get("reason", "Invalidation détectée")
        title  = f"Setup INVALIDE — {e.symbol}"
        msg    = f"Le setup sur {e.symbol} ({e.timeframe}) a été invalidé.\nRaison : {reason}."
        return title, msg

    @staticmethod
    def _build_setup_score_upgraded(e: AlertEvent) -> tuple[str, str]:
        old_s = e.payload.get("old_score", 0)
        new_s = e.payload.get("new_score", 0)
        title = f"Score upgradé — {e.symbol}"
        msg   = f"Le score du setup {e.symbol} ({e.timeframe}) est passé de {old_s} à {new_s}/100."
        return title, msg

    # ── Zones ─────────────────────────────────────────────────────────────────
    @staticmethod
    def _build_zone_sde_detected(e: AlertEvent) -> tuple[str, str]:
        p      = e.payload
        z_top  = p.get("zone_top", 0)
        z_bot  = p.get("zone_bot", 0)
        d      = p.get("direction", "DEMAND")
        score  = p.get("score", 0)
        title  = f"SDE détecté — {e.symbol} {e.timeframe}"
        msg = (
            f"Significant Demand Engulfed détecté sur {e.symbol} ({e.timeframe}).\n"
            f"Direction : {d} | Zone : {z_bot:.5f} — {z_top:.5f}\n"
            f"Score d'englobement : {score}/100.\n"
            f"En attente de la création du SGB pour valider la zone d'entrée."
        )
        return title, msg

    @staticmethod
    def _build_zone_sgb_created(e: AlertEvent) -> tuple[str, str]:
        p     = e.payload
        z_top = p.get("zone_top", 0)
        z_bot = p.get("zone_bot", 0)
        btype = p.get("base_type", BaseType.RBR)
        title = f"SGB créé — {e.symbol} {e.timeframe}"
        msg = (
            f"Significant Base créée sur {e.symbol} ({e.timeframe}).\n"
            f"Type de base : {btype} | Zone d'entrée : {z_bot:.5f} — {z_top:.5f}\n"
            f"C'est la zone d'entrée principale. Attendez le retour du prix (FTB)."
        )
        return title, msg

    @staticmethod
    def _build_zone_sdp_validated(e: AlertEvent) -> tuple[str, str]:
        p     = e.payload
        head  = p.get("head_price", 0)
        title = f"SDP validé — {e.symbol} {e.timeframe}"
        msg = (
            f"Successful Decision Point validé sur {e.symbol} ({e.timeframe}).\n"
            f"Le HEAD a été tenu à {head:.5f}.\n"
            f"La zone est confirmée comme point décisionnel majeur."
        )
        return title, msg

    @staticmethod
    def _build_zone_ftb_approaching(e: AlertEvent) -> tuple[str, str]:
        p    = e.payload
        dist = p.get("distance_pct", 0)
        title = f"Prix approche FTB — {e.symbol}"
        msg = (
            f"Le prix de {e.symbol} ({e.timeframe}) approche de la zone FTB.\n"
            f"Distance restante : {dist:.2f}%.\n"
            f"Préparez votre entrée et surveillez le PA."
        )
        return title, msg

    @staticmethod
    def _build_zone_ftb_hit(e: AlertEvent) -> tuple[str, str]:
        p     = e.payload
        z_top = p.get("zone_top", 0)
        z_bot = p.get("zone_bot", 0)
        rr    = p.get("rr", 0)
        title = f"FTB TOUCHÉ — {e.symbol} {e.timeframe}"
        msg = (
            f"Premier retour sur zone (FTB) confirmé sur {e.symbol} ({e.timeframe}).\n"
            f"Zone : {z_bot:.5f} — {z_top:.5f}\n"
            f"RR potentiel : {rr:.1f}x.\n"
            f"Vérifiez la confirmation de PA avant entrée."
        )
        return title, msg

    @staticmethod
    def _build_zone_flippy_detected(e: AlertEvent) -> tuple[str, str]:
        p         = e.payload
        old_type  = p.get("old_type", "")
        new_type  = p.get("new_type", "")
        title = f"FLIPPY détecté — {e.symbol} {e.timeframe}"
        msg = (
            f"Zone de manipulation (FLIPPY) détectée sur {e.symbol} ({e.timeframe}).\n"
            f"Ancienne zone {old_type} retournée en {new_type}.\n"
            f"Attention : tout setup venant d'un FLIPPY est INVALIDE."
        )
        return title, msg

    @staticmethod
    def _build_zone_failed_sde(e: AlertEvent) -> tuple[str, str]:
        reason = e.payload.get("reason", "Englobement insuffisant")
        title  = f"SDE échoué — {e.symbol}"
        msg    = (
            f"Tentative de SDE échouée sur {e.symbol} ({e.timeframe}).\n"
            f"Raison : {reason}."
        )
        return title, msg

    @staticmethod
    def _build_zone_invalidated(e: AlertEvent) -> tuple[str, str]:
        reason = e.payload.get("reason", "Prix a traversé la zone")
        title  = f"Zone invalidée — {e.symbol}"
        msg    = f"Zone S&D invalidée sur {e.symbol} ({e.timeframe}).\nRaison : {reason}."
        return title, msg

    # ── PA Patterns ───────────────────────────────────────────────────────────
    @staticmethod
    def _build_pa_accu_detected(e: AlertEvent) -> tuple[str, str]:
        title = f"Pattern ACCU — {e.symbol} {e.timeframe}"
        msg   = (
            f"Pattern d'Accumulation (escalier) détecté sur {e.symbol} ({e.timeframe}).\n"
            f"Le prix forme des Higher Lows consécutifs en approche de la zone SGB.\n"
            f"Signal PA de force modérée."
        )
        return title, msg

    @staticmethod
    def _build_pa_three_drives(e: AlertEvent) -> tuple[str, str]:
        p    = e.payload
        drv3 = p.get("third_drive_price", 0)
        title = f"3 DRIVES détecté — {e.symbol} {e.timeframe}"
        msg = (
            f"Pattern Three Drives (le plus puissant) confirmé sur {e.symbol} ({e.timeframe}).\n"
            f"3ème drive complété à {drv3:.5f}.\n"
            f"Signal PA de force MAXIMALE — Priorité entrée."
        )
        return title, msg

    @staticmethod
    def _build_pa_ftl_detected(e: AlertEvent) -> tuple[str, str]:
        title = f"Flip Trend Line — {e.symbol} {e.timeframe}"
        msg   = (
            f"Flip Trend Line (FTL) détecté sur {e.symbol} ({e.timeframe}).\n"
            f"Ancienne ligne de tendance retournée en support/résistance.\n"
            f"Confluence avec la zone SGB confirmée."
        )
        return title, msg

    @staticmethod
    def _build_pa_69_detected(e: AlertEvent) -> tuple[str, str]:
        title = f"Pattern 69 — {e.symbol} {e.timeframe}"
        msg = (
            f"Pattern 69 détecté sur {e.symbol} ({e.timeframe}).\n"
            f"Configuration : FLIPPY + SDE + SGB alignés.\n"
            f"Signal PA de forte conviction — Vérifiez le SDP."
        )
        return title, msg

    @staticmethod
    def _build_pa_hidden_sde(e: AlertEvent) -> tuple[str, str]:
        title = f"Hidden SDE — {e.symbol} {e.timeframe}"
        msg = (
            f"Hidden SDE détecté sur {e.symbol} ({e.timeframe}).\n"
            f"FBO + FLIPPY confirment une zone cachée à surveiller.\n"
            f"Signal PA de haute probabilité."
        )
        return title, msg

    # ── Market Structure ──────────────────────────────────────────────────────
    @staticmethod
    def _build_structure_break(e: AlertEvent) -> tuple[str, str]:
        p         = e.payload
        direction = p.get("direction", "")
        level     = p.get("broken_level", 0)
        title     = f"Structure Breaker — {e.symbol} {e.timeframe}"
        msg = (
            f"Structure Breaker (SB) confirmé sur {e.symbol} ({e.timeframe}).\n"
            f"Direction : {direction} | Niveau cassé : {level:.5f}\n"
            f"Un nouveau SDE peut se former. Surveillez la base créée."
        )
        return title, msg

    @staticmethod
    def _build_structure_phase_change(e: AlertEvent) -> tuple[str, str]:
        old_phase = e.payload.get("old_phase", "")
        new_phase = e.payload.get("new_phase", "")
        title     = f"Changement de phase — {e.symbol}"
        msg = (
            f"Changement de phase de marché sur {e.symbol} ({e.timeframe}).\n"
            f"{old_phase} → {new_phase}.\n"
            f"Réévaluez tous les setups actifs sur cet actif."
        )
        return title, msg

    @staticmethod
    def _build_swing_new_hh(e: AlertEvent) -> tuple[str, str]:
        level = e.payload.get("level", 0)
        title = f"Nouveau Higher High — {e.symbol}"
        msg   = f"Nouveau Higher High confirmé à {level:.5f} sur {e.symbol} ({e.timeframe})."
        return title, msg

    @staticmethod
    def _build_swing_new_ll(e: AlertEvent) -> tuple[str, str]:
        level = e.payload.get("level", 0)
        title = f"Nouveau Lower Low — {e.symbol}"
        msg   = f"Nouveau Lower Low confirmé à {level:.5f} sur {e.symbol} ({e.timeframe})."
        return title, msg

    # ── Decision Point ────────────────────────────────────────────────────────
    @staticmethod
    def _build_dp_price_at_zone(e: AlertEvent) -> tuple[str, str]:
        dp_type = e.payload.get("dp_type", DPType.SDP)
        title   = f"Prix sur DP — {e.symbol} {e.timeframe}"
        msg = (
            f"Le prix de {e.symbol} ({e.timeframe}) est sur un Decision Point ({dp_type}).\n"
            f"Vérifiez le PA et le contexte HTF avant toute entrée."
        )
        return title, msg

    @staticmethod
    def _build_dp_key_level_touch(e: AlertEvent) -> tuple[str, str]:
        level = e.payload.get("level", 0)
        kl_type = e.payload.get("kl_type", "KEY_LEVEL")
        title = f"Key Level touché — {e.symbol}"
        msg   = (
            f"Key Level ({kl_type}) touché à {level:.5f} sur {e.symbol} ({e.timeframe}).\n"
            f"Confluence forte si aligné avec une zone SGB."
        )
        return title, msg

    @staticmethod
    def _build_sl_tp_updated(e: AlertEvent) -> tuple[str, str]:
        sl = e.payload.get("sl", 0)
        tp = e.payload.get("tp", 0)
        rr = e.payload.get("rr", 0)
        title = f"SL/TP mis à jour — {e.symbol}"
        msg   = (
            f"Niveaux SL/TP recalculés pour {e.symbol} ({e.timeframe}).\n"
            f"SL : {sl:.5f} | TP : {tp:.5f} | RR : {rr:.1f}x."
        )
        return title, msg

    # ── Advanced ──────────────────────────────────────────────────────────────
    @staticmethod
    def _build_over_under_detected(e: AlertEvent) -> tuple[str, str]:
        gz = e.payload.get("golden_zone", False)
        title = f"Over & Under — {e.symbol} {e.timeframe}"
        msg = (
            f"Pattern Over & Under détecté sur {e.symbol} ({e.timeframe}).\n"
            f"{'Golden Zone confirmée — ' if gz else ''}Dépassement suivi d'un rejet fort.\n"
            f"Zone d'accumulation institutionnelle probable."
        )
        return title, msg

    @staticmethod
    def _build_iou_detected(e: AlertEvent) -> tuple[str, str]:
        title = f"IOU DÉTECTÉ — {e.symbol} {e.timeframe}"
        msg = (
            f"Ignored Over & Under (IOU) confirmé sur {e.symbol} ({e.timeframe}).\n"
            f"Signal très fort — OU ignoré = conviction institutionnelle maximale.\n"
            f"Priorité haute pour entrée si setup aligné."
        )
        return title, msg

    @staticmethod
    def _build_flag_limit_detected(e: AlertEvent) -> tuple[str, str]:
        title = f"Flag Limit — {e.symbol} {e.timeframe}"
        msg   = f"Pattern Flag Limit détecté sur {e.symbol} ({e.timeframe}). Consolidation serrée avant breakout attendu."
        return title, msg

    @staticmethod
    def _build_counter_attack(e: AlertEvent) -> tuple[str, str]:
        title = f"Contre-attaque — {e.symbol} {e.timeframe}"
        msg   = f"Pattern Contre-Attaque détecté sur {e.symbol} ({e.timeframe}). Rejet violent depuis la zone opposée."
        return title, msg

    # ── Prix ──────────────────────────────────────────────────────────────────
    @staticmethod
    def _build_price_alert_above(e: AlertEvent) -> tuple[str, str]:
        threshold = e.payload.get("threshold", 0)
        price     = e.payload.get("current_price", 0)
        title     = f"Prix > {threshold} — {e.symbol}"
        msg       = f"{e.symbol} a dépassé le seuil {threshold:.5f}. Prix actuel : {price:.5f}."
        return title, msg

    @staticmethod
    def _build_price_alert_below(e: AlertEvent) -> tuple[str, str]:
        threshold = e.payload.get("threshold", 0)
        price     = e.payload.get("current_price", 0)
        title     = f"Prix < {threshold} — {e.symbol}"
        msg       = f"{e.symbol} est passé sous le seuil {threshold:.5f}. Prix actuel : {price:.5f}."
        return title, msg

    @staticmethod
    def _build_price_zone_proximity(e: AlertEvent) -> tuple[str, str]:
        dist  = e.payload.get("distance_pct", 0)
        z_top = e.payload.get("zone_top", 0)
        z_bot = e.payload.get("zone_bot", 0)
        title = f"Proximité zone — {e.symbol}"
        msg   = (
            f"{e.symbol} ({e.timeframe}) est à {dist:.2f}% de la zone "
            f"{z_bot:.5f} — {z_top:.5f}."
        )
        return title, msg

    # ── Système ───────────────────────────────────────────────────────────────
    @staticmethod
    def _build_engine_error(e: AlertEvent) -> tuple[str, str]:
        err = e.payload.get("error", "Erreur inconnue")
        title = f"ERREUR MOTEUR — {e.source}"
        msg   = f"Erreur interne dans {e.source} : {err}"
        return title, msg

    @staticmethod
    def _build_data_stale(e: AlertEvent) -> tuple[str, str]:
        age = e.payload.get("age_seconds", 0)
        title = f"Données obsolètes — {e.symbol}"
        msg   = f"Les données OHLCV de {e.symbol} ({e.timeframe}) n'ont pas été mises à jour depuis {age}s."
        return title, msg

    @staticmethod
    def _build_generic(e: AlertEvent) -> tuple[str, str]:
        title = f"{e.alert_type.value} — {e.symbol}"
        msg   = json.dumps(e.payload, indent=2, default=str)
        return title, msg


# ══════════════════════════════════════════════════════════════════════════════
# GESTIONNAIRE DE DÉDUPLICATION
# ══════════════════════════════════════════════════════════════════════════════

class DedupManager:
    """
    Empêche le spam d'alertes identiques via un cooldown par clé de déduplication.
    Clé = hash(alert_type + symbol + timeframe + payload_signature).
    Stocké en mémoire avec TTL ; en prod, utiliser Redis.
    """

    def __init__(self) -> None:
        # dedup_key → timestamp d'envoi
        self._cache: dict[str, float] = {}

    def _compute_key(self, event: AlertEvent) -> str:
        # Signature du payload : on exclut les champs trop dynamiques (ex: prix exact)
        sig_fields = {
            k: v for k, v in event.payload.items()
            if k not in {"current_price", "distance_pct", "timestamp"}
        }
        raw = f"{event.alert_type.value}:{event.symbol}:{event.timeframe}:{json.dumps(sig_fields, sort_keys=True, default=str)}"
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def is_suppressed(self, event: AlertEvent) -> bool:
        """Retourne True si l'alerte doit être supprimée (cooldown actif)."""
        key     = self._compute_key(event)
        cooldown = ALERT_COOLDOWNS.get(event.alert_type, 60)
        last_ts  = self._cache.get(key, 0)
        now      = time.monotonic()
        if now - last_ts < cooldown:
            log.debug(
                "alert_suppressed",
                alert_type=event.alert_type.value,
                symbol=event.symbol,
                remaining_seconds=int(cooldown - (now - last_ts)),
            )
            return True
        return False

    def mark_sent(self, event: AlertEvent) -> str:
        key = self._compute_key(event)
        self._cache[key] = time.monotonic()
        return key

    def clear_expired(self) -> int:
        """Nettoie les entrées expirées. Retourne le nombre supprimé."""
        now     = time.monotonic()
        expired = [
            k for k, ts in self._cache.items()
            if now - ts > max(ALERT_COOLDOWNS.values(), default=600)
        ]
        for k in expired:
            del self._cache[k]
        return len(expired)

    def get_stats(self) -> dict[str, int]:
        return {"cache_size": len(self._cache)}


# ══════════════════════════════════════════════════════════════════════════════
# HANDLERS DE ROUTING
# ══════════════════════════════════════════════════════════════════════════════

# Type pour les handlers asynchrones
AlertHandler = Callable[[Alert], Coroutine[Any, Any, None]]


class AlertRouter:
    """
    Route les alertes vers les channels appropriés.
    Les handlers externes (Telegram, WebSocket, DB) sont injectés via register().
    """

    def __init__(self) -> None:
        self._handlers: dict[AlertChannel, list[AlertHandler]] = defaultdict(list)

    def register(self, channel: AlertChannel, handler: AlertHandler) -> None:
        """Enregistre un handler pour un channel donné."""
        self._handlers[channel].append(handler)
        log.info("alert_handler_registered", channel=channel.value)

    async def route(self, alert: Alert) -> dict[AlertChannel, bool]:
        """
        Route l'alerte vers tous ses channels.
        Retourne un dict channel → succès.
        """
        results: dict[AlertChannel, bool] = {}

        for channel in alert.channels:
            handlers = self._handlers.get(channel, [])
            if not handlers:
                # Pas de handler enregistré → log uniquement
                log.warning(
                    "no_handler_for_channel",
                    channel=channel.value,
                    alert_id=alert.id,
                )
                results[channel] = False
                continue

            channel_ok = True
            for handler in handlers:
                try:
                    await handler(alert)
                except Exception as exc:
                    log.error(
                        "alert_handler_failed",
                        channel=channel.value,
                        handler=handler.__name__,
                        alert_id=alert.id,
                        error=str(exc),
                    )
                    channel_ok = False
            results[channel] = channel_ok

        return results


# ══════════════════════════════════════════════════════════════════════════════
# QUEUE D'ALERTES PERSISTANTE
# ══════════════════════════════════════════════════════════════════════════════

class AlertQueue:
    """
    Queue asyncio d'alertes avec retry automatique et dead-letter queue.
    Les alertes échouées sont retentées jusqu'à max_retries fois.
    """

    def __init__(self, maxsize: int = 2000) -> None:
        self._queue:      asyncio.Queue[Alert] = asyncio.Queue(maxsize=maxsize)
        self._dead_letter: list[Alert]         = []
        self._processed:   int                 = 0
        self._failed:      int                 = 0

    async def push(self, alert: Alert) -> None:
        try:
            self._queue.put_nowait(alert)
        except asyncio.QueueFull:
            log.error("alert_queue_full", alert_id=alert.id, qsize=self._queue.qsize())

    async def pop(self) -> Optional[Alert]:
        try:
            return await asyncio.wait_for(self._queue.get(), timeout=1.0)
        except asyncio.TimeoutError:
            return None

    def task_done(self) -> None:
        self._queue.task_done()

    def send_to_dead_letter(self, alert: Alert) -> None:
        self._dead_letter.append(alert)
        self._failed += 1
        if len(self._dead_letter) > 500:
            self._dead_letter.pop(0)   # FIFO cap

    def mark_processed(self) -> None:
        self._processed += 1

    def get_stats(self) -> dict[str, int]:
        return {
            "queue_size":   self._queue.qsize(),
            "processed":    self._processed,
            "failed":       self._failed,
            "dead_letter":  len(self._dead_letter),
        }

    def get_dead_letter(self) -> list[Alert]:
        return list(self._dead_letter)


# ══════════════════════════════════════════════════════════════════════════════
# MOTEUR PRINCIPAL
# ══════════════════════════════════════════════════════════════════════════════

class AlertEngine:
    """
    Moteur central d'alertes IGNIS.

    Cycle de vie d'une alerte :
    ─────────────────────────────────────────────────────────────
    AlertEvent  →  [DedupManager]  →  [AlertMessageBuilder]
                →  Alert (objet enrichi)
                →  [AlertQueue]   →  [AlertRouter]
                →  Telegram / WebSocket / Database / Log
    ─────────────────────────────────────────────────────────────

    Usage :
        engine = AlertEngine()
        engine.router.register(AlertChannel.TELEGRAM, telegram_handler)
        engine.router.register(AlertChannel.WEBSOCKET, ws_handler)
        await engine.start()

        # Depuis n'importe quel module :
        await engine.emit(AlertEvent(
            alert_type=AlertType.SETUP_VALID,
            symbol="BTCUSDT",
            timeframe="H4",
            payload={"score": 88, "pa_pattern": "THREE_DRIVES"},
        ))
    """

    def __init__(self) -> None:
        self._dedup   = DedupManager()
        self._queue   = AlertQueue()
        self._router  = AlertRouter()
        self._running = False
        self._worker_task: Optional[asyncio.Task] = None

        # Historique des N dernières alertes envoyées (pour l'API)
        self._history: list[Alert] = []
        self._history_max          = 500

        # Stats globales
        self._stats = {
            "total_events":     0,
            "total_suppressed": 0,
            "total_sent":       0,
            "total_errors":     0,
        }

        # Filtres par symbole/type (pour watchlist utilisateur)
        self._symbol_filters:    set[str]        = set()   # vide = tout passe
        self._disabled_types:    set[AlertType]  = set()

        log.info("alert_engine_initialized")

    @property
    def router(self) -> AlertRouter:
        return self._router

    @property
    def stats(self) -> dict:
        return {
            **self._stats,
            **self._queue.get_stats(),
            **self._dedup.get_stats(),
            "history_size": len(self._history),
        }

    # ── Filtres ───────────────────────────────────────────────────────────────

    def add_symbol_filter(self, symbol: str) -> None:
        """Si des filtres sont définis, seuls ces symboles déclenchent des alertes."""
        self._symbol_filters.add(symbol.upper())

    def remove_symbol_filter(self, symbol: str) -> None:
        self._symbol_filters.discard(symbol.upper())

    def disable_alert_type(self, alert_type: AlertType) -> None:
        self._disabled_types.add(alert_type)

    def enable_alert_type(self, alert_type: AlertType) -> None:
        self._disabled_types.discard(alert_type)

    def _passes_filters(self, event: AlertEvent) -> bool:
        if event.alert_type in self._disabled_types:
            return False
        if self._symbol_filters and event.symbol.upper() not in self._symbol_filters:
            return False
        return True

    # ── Émission ──────────────────────────────────────────────────────────────

    async def emit(self, event: AlertEvent) -> Optional[Alert]:
        """
        Point d'entrée principal. Traite l'événement de manière non-bloquante.
        Retourne l'Alert construite si elle passe les filtres, sinon None.
        """
        self._stats["total_events"] += 1

        # 1. Filtres actifs
        if not self._passes_filters(event):
            log.debug("alert_filtered", alert_type=event.alert_type.value, symbol=event.symbol)
            return None

        # 2. Déduplication
        if self._dedup.is_suppressed(event):
            self._stats["total_suppressed"] += 1
            return None

        # 3. Construction de l'alerte
        alert = self._build_alert(event)

        # 4. Mise en queue pour traitement asynchrone
        await self._queue.push(alert)

        # 5. Marquer le cooldown
        alert.dedup_key = self._dedup.mark_sent(event)

        log.info(
            "alert_queued",
            alert_id=alert.id,
            alert_type=alert.alert_type.value,
            symbol=alert.symbol,
            priority=alert.priority.value,
        )
        return alert

    async def emit_many(self, events: list[AlertEvent]) -> list[Optional[Alert]]:
        """Émet plusieurs événements en parallèle."""
        return await asyncio.gather(*[self.emit(e) for e in events])

    def _build_alert(self, event: AlertEvent) -> Alert:
        """Construit un objet Alert enrichi à partir d'un AlertEvent."""
        priority = ALERT_PRIORITY_MAP.get(event.alert_type, AlertPriority.LOW)
        channels = PRIORITY_CHANNELS_MAP.get(priority, [AlertChannel.LOG])
        emoji    = ALERT_EMOJI_MAP.get(event.alert_type, "ℹ️")
        title, message = AlertMessageBuilder.build(event)

        return Alert(
            id          = str(uuid4()),
            alert_type  = event.alert_type,
            priority    = priority,
            symbol      = event.symbol,
            timeframe   = event.timeframe,
            title       = title,
            message     = message,
            emoji       = emoji,
            payload     = event.payload,
            channels    = channels,
            created_at  = event.timestamp,
        )

    # ── Worker ────────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Démarre le worker de traitement de la queue."""
        if self._running:
            return
        self._running = True
        self._worker_task = asyncio.create_task(self._worker_loop(), name="alert_engine_worker")
        log.info("alert_engine_started")

    async def stop(self) -> None:
        """Arrête proprement le worker."""
        self._running = False
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass
        log.info("alert_engine_stopped", stats=self._stats)

    async def _worker_loop(self) -> None:
        """Boucle principale du worker : dépile et route les alertes."""
        cleanup_counter = 0
        while self._running:
            alert = await self._queue.pop()
            if alert is None:
                continue

            try:
                results = await self._router.route(alert)
                success  = all(results.values())

                if success:
                    alert.status  = AlertStatus.SENT
                    alert.sent_at = datetime.now(timezone.utc)
                    self._stats["total_sent"] += 1
                    self._queue.mark_processed()
                else:
                    # Retry si possible
                    if alert.retry_count < alert.max_retries:
                        alert.retry_count += 1
                        await asyncio.sleep(2 ** alert.retry_count)  # backoff exponentiel
                        await self._queue.push(alert)
                        log.warning(
                            "alert_retry",
                            alert_id=alert.id,
                            retry=alert.retry_count,
                        )
                    else:
                        alert.status = AlertStatus.FAILED
                        self._queue.send_to_dead_letter(alert)
                        self._stats["total_errors"] += 1
                        log.error("alert_dead_letter", alert_id=alert.id)

            except Exception as exc:
                self._stats["total_errors"] += 1
                log.exception("alert_worker_error", alert_id=alert.id, error=str(exc))

            finally:
                self._queue.task_done()
                self._add_to_history(alert)

            # Nettoyage périodique du cache dedup (toutes les 100 alertes)
            cleanup_counter += 1
            if cleanup_counter % 100 == 0:
                removed = self._dedup.clear_expired()
                log.debug("dedup_cache_cleanup", removed=removed)

    # ── Historique ────────────────────────────────────────────────────────────

    def _add_to_history(self, alert: Alert) -> None:
        self._history.append(alert)
        if len(self._history) > self._history_max:
            self._history.pop(0)

    def get_history(
        self,
        symbol:     Optional[str]        = None,
        alert_type: Optional[AlertType]  = None,
        priority:   Optional[AlertPriority] = None,
        limit:      int                  = 50,
        since:      Optional[datetime]   = None,
    ) -> list[Alert]:
        """Retourne l'historique filtré des alertes."""
        result = list(self._history)

        if symbol:
            result = [a for a in result if a.symbol == symbol.upper()]
        if alert_type:
            result = [a for a in result if a.alert_type == alert_type]
        if priority:
            result = [a for a in result if a.priority == priority]
        if since:
            result = [a for a in result if a.created_at >= since]

        return result[-limit:]

    def get_history_dicts(self, **kwargs) -> list[dict]:
        return [a.to_dict() for a in self.get_history(**kwargs)]

    # ── Alertes de prix (depuis watchlist) ────────────────────────────────────

    async def check_price_alerts(
        self,
        symbol:        str,
        current_price: float,
        price_alerts:  list[dict],
    ) -> None:
        """
        Vérifie les alertes de prix configurées par l'utilisateur.
        price_alerts : [{"threshold": float, "direction": "above"|"below"}, ...]
        """
        for pa in price_alerts:
            threshold = pa.get("threshold", 0)
            direction = pa.get("direction", "above")

            if direction == "above" and current_price >= threshold:
                await self.emit(AlertEvent(
                    alert_type=AlertType.PRICE_ALERT_ABOVE,
                    symbol=symbol,
                    timeframe="--",
                    payload={"threshold": threshold, "current_price": current_price},
                ))
            elif direction == "below" and current_price <= threshold:
                await self.emit(AlertEvent(
                    alert_type=AlertType.PRICE_ALERT_BELOW,
                    symbol=symbol,
                    timeframe="--",
                    payload={"threshold": threshold, "current_price": current_price},
                ))

    async def check_zone_proximity(
        self,
        symbol:       str,
        timeframe:    str,
        current_price: float,
        zones:        list[dict],
        proximity_pct: float = 0.005,  # 0.5% par défaut
    ) -> None:
        """
        Vérifie si le prix est proche d'une zone S&D active.
        zones : [{"zone_top": float, "zone_bot": float, "zone_type": str}, ...]
        """
        for zone in zones:
            z_top = zone.get("zone_top", 0)
            z_bot = zone.get("zone_bot", 0)
            mid   = (z_top + z_bot) / 2
            if mid <= 0:
                continue
            dist_pct = abs(current_price - mid) / mid
            if dist_pct <= proximity_pct:
                await self.emit(AlertEvent(
                    alert_type=AlertType.PRICE_ZONE_PROXIMITY,
                    symbol=symbol,
                    timeframe=timeframe,
                    payload={
                        "zone_top":      z_top,
                        "zone_bot":      z_bot,
                        "zone_type":     zone.get("zone_type", ""),
                        "distance_pct":  round(dist_pct * 100, 3),
                        "current_price": current_price,
                    },
                ))


# ══════════════════════════════════════════════════════════════════════════════
# INSTANCE SINGLETON (importée par main.py)
# ══════════════════════════════════════════════════════════════════════════════

alert_engine = AlertEngine()


# ══════════════════════════════════════════════════════════════════════════════
# HELPER — émission rapide sans instance directe
# ══════════════════════════════════════════════════════════════════════════════

async def emit_alert(
    alert_type: AlertType,
    symbol:     str,
    timeframe:  str,
    payload:    dict[str, Any],
    source:     str = "ignis_core",
) -> Optional[Alert]:
    """Shortcut global pour émettre une alerte depuis n'importe quel module."""
    return await alert_engine.emit(AlertEvent(
        alert_type=alert_type,
        symbol=symbol,
        timeframe=timeframe,
        payload=payload,
        source=source,
    ))