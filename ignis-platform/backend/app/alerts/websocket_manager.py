"""
websocket_manager.py — Gestionnaire WebSocket IGNIS
Push temps réel vers le frontend : alertes, prix live, mises à jour de setup.
Supporte : rooms par symbole/timeframe, broadcast, heartbeat, reconnexion.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState
import structlog

from app.alerts.alert_engine import Alert, AlertPriority

log = structlog.get_logger(__name__)

# ══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════════════════════

WS_PING_INTERVAL        = 25       # secondes entre chaque ping
WS_PING_TIMEOUT         = 10       # secondes avant de considérer le client mort
WS_MAX_CONNECTIONS      = 500      # connexions simultanées max
WS_MAX_PER_SYMBOL       = 100      # connexions max par room symbole
WS_MESSAGE_QUEUE_SIZE   = 200      # taille de la queue par connexion
WS_MAX_MESSAGE_SIZE     = 65_536   # 64KB max par message
WS_HEARTBEAT_INTERVAL   = 30       # secondes entre heartbeats
WS_RECONNECT_GRACE      = 5        # secondes de grâce après déconnexion


# ══════════════════════════════════════════════════════════════════════════════
# ENUMS & TYPES DE MESSAGES
# ══════════════════════════════════════════════════════════════════════════════

class WSMessageType(str, Enum):
    # ── Serveur → Client ──────────────────────────────────────────────────────
    ALERT              = "alert"               # Nouvelle alerte S&D
    PRICE_UPDATE       = "price_update"        # Tick de prix live
    CANDLE_UPDATE      = "candle_update"       # Bougie OHLCV mise à jour
    SETUP_UPDATE       = "setup_update"        # Statut setup changé
    ZONE_UPDATE        = "zone_update"         # Zone S&D créée/modifiée/invalidée
    STRUCTURE_UPDATE   = "structure_update"    # Market structure mise à jour
    ANALYSIS_COMPLETE  = "analysis_complete"   # Analyse pipeline terminée
    HEARTBEAT          = "heartbeat"           # Ping serveur
    CONNECTED          = "connected"           # Confirmation connexion
    SUBSCRIBED         = "subscribed"          # Confirmation souscription room
    UNSUBSCRIBED       = "unsubscribed"        # Confirmation désinscription
    ERROR              = "error"               # Erreur serveur
    RECONNECT          = "reconnect"           # Demande de reconnexion au client

    # ── Client → Serveur ──────────────────────────────────────────────────────
    SUBSCRIBE          = "subscribe"           # Souscrire à un symbole/TF
    UNSUBSCRIBE        = "unsubscribe"         # Se désinscrire
    PING               = "ping"                # Ping client
    PONG               = "pong"                # Pong client
    REQUEST_ANALYSIS   = "request_analysis"    # Demande d'analyse


class WSCloseCode(int, Enum):
    NORMAL           = 1000
    GOING_AWAY       = 1001
    PROTOCOL_ERROR   = 1002
    INVALID_DATA     = 1003
    MAX_CONNECTIONS  = 4000
    AUTH_FAILED      = 4001
    RATE_LIMITED     = 4002
    SERVER_ERROR     = 4003


# ══════════════════════════════════════════════════════════════════════════════
# MODÈLES
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class WSMessage:
    """Message WebSocket structuré."""
    type:      WSMessageType
    data:      dict[str, Any]       = field(default_factory=dict)
    room:      Optional[str]        = None
    ts:        int                  = field(default_factory=lambda: int(time.time() * 1000))
    msg_id:    str                  = field(default_factory=lambda: str(uuid4())[:8])

    def to_json(self) -> str:
        return json.dumps({
            "type":   self.type.value,
            "data":   self.data,
            "room":   self.room,
            "ts":     self.ts,
            "msg_id": self.msg_id,
        }, default=str)

    def __len__(self) -> int:
        return len(self.to_json().encode())


@dataclass
class ConnectionInfo:
    """Métadonnées d'une connexion WebSocket."""
    connection_id:  str
    websocket:      WebSocket
    client_ip:      str                 = "unknown"
    user_agent:     str                 = ""
    connected_at:   datetime            = field(default_factory=lambda: datetime.now(timezone.utc))
    last_ping:      float               = field(default_factory=time.monotonic)
    last_pong:      float               = field(default_factory=time.monotonic)
    subscriptions:  set[str]            = field(default_factory=set)   # rooms
    message_queue:  asyncio.Queue       = field(default_factory=lambda: asyncio.Queue(WS_MESSAGE_QUEUE_SIZE))
    is_alive:       bool                = True
    messages_sent:  int                 = 0
    messages_dropped: int               = 0
    bytes_sent:     int                 = 0

    @property
    def is_connected(self) -> bool:
        return (
            self.is_alive
            and self.websocket.client_state == WebSocketState.CONNECTED
        )

    @property
    def latency_ms(self) -> float:
        """Estimation de la latence (délai pong - ping)."""
        return max(0.0, (self.last_pong - self.last_ping) * 1000)

    def to_dict(self) -> dict[str, Any]:
        return {
            "connection_id":    self.connection_id,
            "client_ip":        self.client_ip,
            "connected_at":     self.connected_at.isoformat(),
            "subscriptions":    list(self.subscriptions),
            "messages_sent":    self.messages_sent,
            "messages_dropped": self.messages_dropped,
            "bytes_sent":       self.bytes_sent,
            "latency_ms":       round(self.latency_ms, 2),
            "is_alive":         self.is_alive,
        }


# ══════════════════════════════════════════════════════════════════════════════
# RATE LIMITER PAR CONNEXION
# ══════════════════════════════════════════════════════════════════════════════

class WSRateLimiter:
    """
    Rate limiting par connexion WebSocket.
    Limite les messages entrants (actions client) pour éviter les abus.
    """

    def __init__(self, max_per_second: int = 10, max_per_minute: int = 200) -> None:
        self._max_per_second = max_per_second
        self._max_per_minute = max_per_minute
        # connection_id → (tokens, last_refill)
        self._second_bucket: dict[str, tuple[float, float]] = {}
        self._minute_counts: dict[str, list[float]]         = defaultdict(list)

    def is_allowed(self, connection_id: str) -> bool:
        now = time.monotonic()

        # Token bucket par seconde
        tokens, last = self._second_bucket.get(connection_id, (float(self._max_per_second), now))
        elapsed       = now - last
        tokens        = min(float(self._max_per_second), tokens + elapsed * self._max_per_second)

        if tokens < 1.0:
            return False

        self._second_bucket[connection_id] = (tokens - 1.0, now)

        # Sliding window par minute
        minute_ts = self._minute_counts[connection_id]
        cutoff    = now - 60.0
        self._minute_counts[connection_id] = [t for t in minute_ts if t > cutoff]
        if len(self._minute_counts[connection_id]) >= self._max_per_minute:
            return False

        self._minute_counts[connection_id].append(now)
        return True

    def cleanup(self, connection_id: str) -> None:
        self._second_bucket.pop(connection_id, None)
        self._minute_counts.pop(connection_id, None)


# ══════════════════════════════════════════════════════════════════════════════
# ROOM MANAGER — souscriptions par symbole/timeframe
# ══════════════════════════════════════════════════════════════════════════════

class RoomManager:
    """
    Gère les rooms de souscription.
    Room key format : "{SYMBOL}:{TIMEFRAME}"  ex: "BTCUSDT:H4"
    Room spéciale   : "global" pour toutes les alertes CRITICAL
    """

    def __init__(self) -> None:
        # room_key → set of connection_ids
        self._rooms: dict[str, set[str]] = defaultdict(set)
        # connection_id → set of room_keys
        self._conn_rooms: dict[str, set[str]] = defaultdict(set)

    @staticmethod
    def make_key(symbol: str, timeframe: str = "*") -> str:
        return f"{symbol.upper()}:{timeframe.upper()}"

    def subscribe(self, connection_id: str, room_key: str) -> bool:
        """Ajoute une connexion à une room. Retourne False si trop de membres."""
        if len(self._rooms[room_key]) >= WS_MAX_PER_SYMBOL:
            return False
        self._rooms[room_key].add(connection_id)
        self._conn_rooms[connection_id].add(room_key)
        log.debug("ws_room_subscribe", connection_id=connection_id, room=room_key)
        return True

    def unsubscribe(self, connection_id: str, room_key: str) -> None:
        self._rooms[room_key].discard(connection_id)
        self._conn_rooms[connection_id].discard(room_key)
        if not self._rooms[room_key]:
            del self._rooms[room_key]

    def remove_connection(self, connection_id: str) -> None:
        """Retire une connexion de toutes ses rooms."""
        for room_key in list(self._conn_rooms.get(connection_id, [])):
            self._rooms[room_key].discard(connection_id)
            if not self._rooms[room_key]:
                self._rooms.pop(room_key, None)
        self._conn_rooms.pop(connection_id, None)

    def get_subscribers(self, room_key: str) -> set[str]:
        return set(self._rooms.get(room_key, set()))

    def get_rooms_for_connection(self, connection_id: str) -> set[str]:
        return set(self._conn_rooms.get(connection_id, set()))

    def get_rooms_for_symbol(self, symbol: str) -> list[str]:
        prefix = f"{symbol.upper()}:"
        return [k for k in self._rooms if k.startswith(prefix)]

    def get_stats(self) -> dict[str, Any]:
        return {
            "total_rooms":        len(self._rooms),
            "rooms": {
                k: len(v) for k, v in self._rooms.items()
            },
        }


# ══════════════════════════════════════════════════════════════════════════════
# GESTIONNAIRE PRINCIPAL
# ══════════════════════════════════════════════════════════════════════════════

class WebSocketManager:
    """
    Gestionnaire central WebSocket IGNIS.

    Responsabilités :
    ─────────────────────────────────────────────────────────────
    • Accepter et gérer les connexions WebSocket
    • Router les messages vers les rooms abonnées
    • Broadcast des alertes, prix, setups en temps réel
    • Heartbeat / détection de connexions mortes
    • Rate limiting par connexion
    • Stats & monitoring
    ─────────────────────────────────────────────────────────────

    Usage dans FastAPI :
        ws_manager = WebSocketManager()

        @app.websocket("/ws")
        async def websocket_endpoint(ws: WebSocket):
            await ws_manager.connect(ws)

        # Depuis n'importe quel module :
        await ws_manager.broadcast_alert(alert)
        await ws_manager.broadcast_price(symbol, price, change_pct)
    """

    def __init__(self) -> None:
        self._connections:  dict[str, ConnectionInfo]  = {}
        self._rooms         = RoomManager()
        self._rate_limiter  = WSRateLimiter()
        self._running       = False
        self._heartbeat_task: Optional[asyncio.Task]   = None
        self._cleanup_task:   Optional[asyncio.Task]   = None

        self._stats = {
            "total_connections":    0,
            "total_disconnections": 0,
            "total_messages_sent":  0,
            "total_messages_dropped": 0,
            "total_bytes_sent":     0,
            "peak_connections":     0,
        }

        log.info("websocket_manager_initialized")

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._running:
            return
        self._running        = True
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(), name="ws_heartbeat")
        self._cleanup_task   = asyncio.create_task(self._cleanup_loop(),   name="ws_cleanup")
        log.info("websocket_manager_started")

    async def stop(self) -> None:
        self._running = False

        # Fermer toutes les connexions proprement
        close_tasks = [
            self._close_connection(conn_id, WSCloseCode.GOING_AWAY, "Server shutting down")
            for conn_id in list(self._connections)
        ]
        await asyncio.gather(*close_tasks, return_exceptions=True)

        for task in (self._heartbeat_task, self._cleanup_task):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        log.info("websocket_manager_stopped", stats=self._stats)

    # ── Connexion ──────────────────────────────────────────────────────────────

    async def connect(self, websocket: WebSocket) -> str:
        """
        Accepte une nouvelle connexion WebSocket.
        Retourne le connection_id.
        """
        if len(self._connections) >= WS_MAX_CONNECTIONS:
            await websocket.close(code=WSCloseCode.MAX_CONNECTIONS)
            log.warning("ws_max_connections_reached", current=len(self._connections))
            raise ConnectionError("Max WebSocket connections reached")

        await websocket.accept()

        conn_id    = str(uuid4())
        client_ip  = self._extract_ip(websocket)
        user_agent = websocket.headers.get("user-agent", "")

        conn = ConnectionInfo(
            connection_id = conn_id,
            websocket     = websocket,
            client_ip     = client_ip,
            user_agent    = user_agent,
        )
        self._connections[conn_id] = conn

        # Mettre à jour les stats
        self._stats["total_connections"] += 1
        self._stats["peak_connections"]   = max(
            self._stats["peak_connections"],
            len(self._connections),
        )

        # Souscrire automatiquement à la room "global"
        self._rooms.subscribe(conn_id, "global")

        # Démarrer le worker d'envoi pour cette connexion
        asyncio.create_task(
            self._send_worker(conn_id),
            name=f"ws_send_{conn_id[:8]}",
        )

        # Message de bienvenue
        await self._enqueue(conn_id, WSMessage(
            type=WSMessageType.CONNECTED,
            data={
                "connection_id":   conn_id,
                "server_time":     int(time.time() * 1000),
                "ping_interval":   WS_PING_INTERVAL,
                "heartbeat_interval": WS_HEARTBEAT_INTERVAL,
            },
        ))

        log.info(
            "ws_connected",
            connection_id=conn_id,
            client_ip=client_ip,
            total_connections=len(self._connections),
        )
        return conn_id

    async def disconnect(self, connection_id: str) -> None:
        """Déconnexion propre d'un client."""
        await self._close_connection(connection_id, WSCloseCode.NORMAL, "Client disconnected")

    async def _close_connection(
        self,
        connection_id: str,
        code:          WSCloseCode = WSCloseCode.NORMAL,
        reason:        str         = "",
    ) -> None:
        conn = self._connections.pop(connection_id, None)
        if not conn:
            return

        conn.is_alive = False
        self._rooms.remove_connection(connection_id)
        self._rate_limiter.cleanup(connection_id)
        self._stats["total_disconnections"] += 1

        try:
            if conn.websocket.client_state == WebSocketState.CONNECTED:
                await conn.websocket.close(code=code.value)
        except Exception:
            pass

        log.info(
            "ws_disconnected",
            connection_id=connection_id,
            code=code.value,
            reason=reason,
            messages_sent=conn.messages_sent,
            total_connections=len(self._connections),
        )

    # ── Réception des messages clients ────────────────────────────────────────

    async def handle_connection(self, connection_id: str) -> None:
        """
        Boucle principale de réception pour une connexion.
        À appeler dans l'endpoint WebSocket FastAPI après connect().
        """
        conn = self._connections.get(connection_id)
        if not conn:
            return

        try:
            while conn.is_connected:
                try:
                    raw = await asyncio.wait_for(
                        conn.websocket.receive_text(),
                        timeout=WS_PING_TIMEOUT + WS_PING_INTERVAL,
                    )
                    await self._handle_client_message(connection_id, raw)

                except asyncio.TimeoutError:
                    # Client non réactif → fermer
                    log.warning("ws_client_timeout", connection_id=connection_id)
                    await self._close_connection(connection_id, WSCloseCode.GOING_AWAY, "Timeout")
                    break

        except WebSocketDisconnect as exc:
            log.info("ws_client_disconnected", connection_id=connection_id, code=exc.code)
        except Exception as exc:
            log.exception("ws_handle_error", connection_id=connection_id, error=str(exc))
        finally:
            await self._close_connection(connection_id, WSCloseCode.GOING_AWAY, "Connection ended")

    async def _handle_client_message(self, connection_id: str, raw: str) -> None:
        """Parse et route les messages entrants du client."""
        if not self._rate_limiter.is_allowed(connection_id):
            await self._enqueue(connection_id, WSMessage(
                type=WSMessageType.ERROR,
                data={"code": "RATE_LIMITED", "message": "Too many messages"},
            ))
            return

        try:
            data    = json.loads(raw)
            msg_type = data.get("type", "")
        except json.JSONDecodeError:
            await self._enqueue(connection_id, WSMessage(
                type=WSMessageType.ERROR,
                data={"code": "INVALID_JSON", "message": "Invalid JSON"},
            ))
            return

        conn = self._connections.get(connection_id)
        if not conn:
            return

        if msg_type == WSMessageType.PING:
            conn.last_ping = time.monotonic()
            await self._enqueue(connection_id, WSMessage(
                type=WSMessageType.HEARTBEAT,
                data={"server_time": int(time.time() * 1000)},
            ))

        elif msg_type == WSMessageType.PONG:
            conn.last_pong = time.monotonic()

        elif msg_type == WSMessageType.SUBSCRIBE:
            await self._handle_subscribe(connection_id, data.get("data", {}))

        elif msg_type == WSMessageType.UNSUBSCRIBE:
            await self._handle_unsubscribe(connection_id, data.get("data", {}))

        elif msg_type == WSMessageType.REQUEST_ANALYSIS:
            await self._handle_analysis_request(connection_id, data.get("data", {}))

        else:
            log.debug("ws_unknown_message_type", msg_type=msg_type, connection_id=connection_id)

    async def _handle_subscribe(self, connection_id: str, data: dict) -> None:
        symbol    = data.get("symbol", "").upper()
        timeframe = data.get("timeframe", "*").upper()

        if not symbol:
            await self._enqueue(connection_id, WSMessage(
                type=WSMessageType.ERROR,
                data={"code": "MISSING_SYMBOL", "message": "symbol is required"},
            ))
            return

        room_key = RoomManager.make_key(symbol, timeframe)
        success  = self._rooms.subscribe(connection_id, room_key)

        conn = self._connections.get(connection_id)
        if conn:
            conn.subscriptions.add(room_key)

        await self._enqueue(connection_id, WSMessage(
            type=WSMessageType.SUBSCRIBED,
            data={
                "room":      room_key,
                "symbol":    symbol,
                "timeframe": timeframe,
                "success":   success,
                "reason":    "" if success else "Room capacity reached",
            },
        ))
        log.info("ws_subscribed", connection_id=connection_id, room=room_key, success=success)

    async def _handle_unsubscribe(self, connection_id: str, data: dict) -> None:
        symbol    = data.get("symbol", "").upper()
        timeframe = data.get("timeframe", "*").upper()
        room_key  = RoomManager.make_key(symbol, timeframe)

        self._rooms.unsubscribe(connection_id, room_key)

        conn = self._connections.get(connection_id)
        if conn:
            conn.subscriptions.discard(room_key)

        await self._enqueue(connection_id, WSMessage(
            type=WSMessageType.UNSUBSCRIBED,
            data={"room": room_key, "symbol": symbol, "timeframe": timeframe},
        ))

    async def _handle_analysis_request(self, connection_id: str, data: dict) -> None:
        """
        Le client demande une analyse pour un symbole/TF.
        Émis vers le pipeline d'analyse — résultat renvoyé via ANALYSIS_COMPLETE.
        """
        symbol    = data.get("symbol", "").upper()
        timeframe = data.get("timeframe", "H4").upper()

        if not symbol:
            return

        # Import ici pour éviter les imports circulaires
        try:
            from app.core.setup_scanner.setup_pipeline import run_pipeline_for_symbol
            asyncio.create_task(
                run_pipeline_for_symbol(
                    symbol=symbol,
                    timeframe=timeframe,
                    on_complete=lambda result: self.broadcast_analysis_complete(symbol, timeframe, result),
                ),
                name=f"pipeline_{symbol}_{timeframe}",
            )
        except ImportError:
            log.warning("ws_pipeline_not_available")

    # ── Worker d'envoi ────────────────────────────────────────────────────────

    async def _send_worker(self, connection_id: str) -> None:
        """
        Worker dédié par connexion.
        Dépile la queue et envoie les messages un par un.
        """
        conn = self._connections.get(connection_id)
        if not conn:
            return

        while conn.is_alive and conn.is_connected:
            try:
                msg: WSMessage = await asyncio.wait_for(
                    conn.message_queue.get(),
                    timeout=WS_PING_INTERVAL + 5,
                )
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            try:
                payload = msg.to_json()
                if len(payload.encode()) > WS_MAX_MESSAGE_SIZE:
                    log.warning(
                        "ws_message_too_large",
                        connection_id=connection_id,
                        size=len(payload),
                    )
                    conn.message_queue.task_done()
                    continue

                await conn.websocket.send_text(payload)

                conn.messages_sent  += 1
                conn.bytes_sent     += len(payload.encode())
                self._stats["total_messages_sent"] += 1
                self._stats["total_bytes_sent"]    += len(payload.encode())

            except WebSocketDisconnect:
                conn.is_alive = False
                break
            except Exception as exc:
                log.error("ws_send_error", connection_id=connection_id, error=str(exc))
                conn.is_alive = False
                break
            finally:
                try:
                    conn.message_queue.task_done()
                except ValueError:
                    pass

    async def _enqueue(self, connection_id: str, msg: WSMessage) -> bool:
        """Ajoute un message à la queue d'envoi d'une connexion."""
        conn = self._connections.get(connection_id)
        if not conn or not conn.is_alive:
            return False
        try:
            conn.message_queue.put_nowait(msg)
            return True
        except asyncio.QueueFull:
            conn.messages_dropped          += 1
            self._stats["total_messages_dropped"] += 1
            log.warning(
                "ws_queue_full_drop",
                connection_id=connection_id,
                msg_type=msg.type.value,
            )
            return False

    # ── Broadcast ─────────────────────────────────────────────────────────────

    async def broadcast_to_room(
        self,
        room_key: str,
        msg:      WSMessage,
    ) -> int:
        """Envoie un message à tous les abonnés d'une room. Retourne le nb de destinataires."""
        subscribers = self._rooms.get_subscribers(room_key)
        if not subscribers:
            return 0

        sent = 0
        for conn_id in subscribers:
            if await self._enqueue(conn_id, msg):
                sent += 1
        return sent

    async def broadcast_to_all(self, msg: WSMessage) -> int:
        """Envoie à toutes les connexions actives."""
        sent = 0
        for conn_id in list(self._connections):
            if await self._enqueue(conn_id, msg):
                sent += 1
        return sent

    async def handle_alert(self, alert: Alert) -> None:
        """
        Handler principal appelé par AlertEngine.
        Route l'alerte vers les rooms concernées.
        """
        msg = WSMessage(
            type = WSMessageType.ALERT,
            room = RoomManager.make_key(alert.symbol, alert.timeframe),
            data = alert.to_websocket_payload(),
        )

        sent_total = 0

        # 1. Room spécifique symbole:timeframe
        room_key = RoomManager.make_key(alert.symbol, alert.timeframe)
        sent_total += await self.broadcast_to_room(room_key, msg)

        # 2. Room symbole:* (toutes timeframes)
        wildcard_key = RoomManager.make_key(alert.symbol, "*")
        sent_total += await self.broadcast_to_room(wildcard_key, msg)

        # 3. Room global pour les alertes CRITICAL et HIGH
        if alert.priority in (AlertPriority.CRITICAL, AlertPriority.HIGH):
            sent_total += await self.broadcast_to_room("global", msg)

        log.debug(
            "ws_alert_broadcast",
            alert_id=alert.id,
            symbol=alert.symbol,
            rooms_reached=sent_total,
        )

    async def broadcast_price(
        self,
        symbol:      str,
        price:       float,
        change_pct:  float,
        volume:      float = 0.0,
        bid:         float = 0.0,
        ask:         float = 0.0,
    ) -> None:
        """Broadcast d'un tick de prix live vers les abonnés du symbole."""
        msg = WSMessage(
            type=WSMessageType.PRICE_UPDATE,
            room=RoomManager.make_key(symbol),
            data={
                "symbol":     symbol,
                "price":      price,
                "change_pct": round(change_pct, 4),
                "volume":     volume,
                "bid":        bid,
                "ask":        ask,
            },
        )
        # Envoyer à toutes les rooms du symbole (peu importe le TF)
        rooms = self._rooms.get_rooms_for_symbol(symbol)
        for room_key in rooms:
            await self.broadcast_to_room(room_key, msg)

    async def broadcast_candle(
        self,
        symbol:    str,
        timeframe: str,
        candle:    dict[str, Any],
        is_closed: bool = False,
    ) -> None:
        """Broadcast d'une mise à jour de bougie OHLCV."""
        msg = WSMessage(
            type=WSMessageType.CANDLE_UPDATE,
            room=RoomManager.make_key(symbol, timeframe),
            data={
                "symbol":    symbol,
                "timeframe": timeframe,
                "candle":    candle,
                "is_closed": is_closed,
            },
        )
        room_key = RoomManager.make_key(symbol, timeframe)
        await self.broadcast_to_room(room_key, msg)

    async def broadcast_setup_update(
        self,
        symbol:    str,
        timeframe: str,
        setup:     dict[str, Any],
    ) -> None:
        """Broadcast d'une mise à jour de statut de setup."""
        msg = WSMessage(
            type=WSMessageType.SETUP_UPDATE,
            room=RoomManager.make_key(symbol, timeframe),
            data={
                "symbol":    symbol,
                "timeframe": timeframe,
                "setup":     setup,
            },
        )
        room_key = RoomManager.make_key(symbol, timeframe)
        await self.broadcast_to_room(room_key, msg)

        # Aussi en global si setup VALID
        if setup.get("status") == "VALID":
            await self.broadcast_to_room("global", msg)

    async def broadcast_zone_update(
        self,
        symbol:    str,
        timeframe: str,
        zone:      dict[str, Any],
        action:    str = "created",   # created | updated | invalidated
    ) -> None:
        """Broadcast d'une mise à jour de zone S&D."""
        msg = WSMessage(
            type=WSMessageType.ZONE_UPDATE,
            room=RoomManager.make_key(symbol, timeframe),
            data={
                "symbol":    symbol,
                "timeframe": timeframe,
                "zone":      zone,
                "action":    action,
            },
        )
        room_key = RoomManager.make_key(symbol, timeframe)
        await self.broadcast_to_room(room_key, msg)

    async def broadcast_structure_update(
        self,
        symbol:    str,
        timeframe: str,
        structure: dict[str, Any],
    ) -> None:
        """Broadcast d'une mise à jour de structure de marché."""
        msg = WSMessage(
            type=WSMessageType.STRUCTURE_UPDATE,
            room=RoomManager.make_key(symbol, timeframe),
            data={
                "symbol":    symbol,
                "timeframe": timeframe,
                "structure": structure,
            },
        )
        room_key = RoomManager.make_key(symbol, timeframe)
        await self.broadcast_to_room(room_key, msg)

    async def broadcast_analysis_complete(
        self,
        symbol:    str,
        timeframe: str,
        result:    dict[str, Any],
    ) -> None:
        """Broadcast du résultat complet d'un pipeline d'analyse."""
        msg = WSMessage(
            type=WSMessageType.ANALYSIS_COMPLETE,
            room=RoomManager.make_key(symbol, timeframe),
            data={
                "symbol":    symbol,
                "timeframe": timeframe,
                "result":    result,
            },
        )
        room_key = RoomManager.make_key(symbol, timeframe)
        await self.broadcast_to_room(room_key, msg)

    async def send_to_connection(
        self,
        connection_id: str,
        msg:           WSMessage,
    ) -> bool:
        """Envoie un message à une connexion spécifique."""
        return await self._enqueue(connection_id, msg)

    # ── Heartbeat & Cleanup ────────────────────────────────────────────────────

    async def _heartbeat_loop(self) -> None:
        """Envoie un heartbeat périodique et détecte les connexions mortes."""
        while self._running:
            await asyncio.sleep(WS_HEARTBEAT_INTERVAL)
            now   = time.monotonic()
            dead  = []

            for conn_id, conn in list(self._connections.items()):
                # Détecter les connexions sans pong depuis trop longtemps
                if now - conn.last_pong > WS_PING_INTERVAL + WS_PING_TIMEOUT:
                    dead.append(conn_id)
                    continue

                # Envoyer heartbeat
                await self._enqueue(conn_id, WSMessage(
                    type=WSMessageType.HEARTBEAT,
                    data={
                        "server_time": int(time.time() * 1000),
                        "connections": len(self._connections),
                    },
                ))
                conn.last_ping = now

            # Fermer les connexions mortes
            for conn_id in dead:
                log.warning("ws_dead_connection_cleanup", connection_id=conn_id)
                await self._close_connection(conn_id, WSCloseCode.GOING_AWAY, "Heartbeat timeout")

    async def _cleanup_loop(self) -> None:
        """Nettoyage périodique des connexions fermées."""
        while self._running:
            await asyncio.sleep(60)
            dead = [
                conn_id
                for conn_id, conn in list(self._connections.items())
                if not conn.is_alive or conn.websocket.client_state != WebSocketState.CONNECTED
            ]
            for conn_id in dead:
                await self._close_connection(conn_id, WSCloseCode.GOING_AWAY, "Cleanup stale")

            if dead:
                log.info("ws_cleanup_stale_connections", removed=len(dead))

    # ── Stats & Monitoring ────────────────────────────────────────────────────

    @property
    def active_connections(self) -> int:
        return len(self._connections)

    def get_stats(self) -> dict[str, Any]:
        return {
            **self._stats,
            "active_connections": len(self._connections),
            "rooms":              self._rooms.get_stats(),
            "connections": [
                conn.to_dict()
                for conn in list(self._connections.values())
            ],
        }

    def get_connection(self, connection_id: str) -> Optional[ConnectionInfo]:
        return self._connections.get(connection_id)

    @staticmethod
    def _extract_ip(websocket: WebSocket) -> str:
        forwarded = websocket.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
        if websocket.client:
            return websocket.client.host
        return "unknown"


# ══════════════════════════════════════════════════════════════════════════════
# INSTANCE SINGLETON
# ══════════════════════════════════════════════════════════════════════════════

ws_manager = WebSocketManager()