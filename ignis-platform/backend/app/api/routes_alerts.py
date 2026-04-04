"""
routes_alerts.py — Routes API alertes IGNIS
CRUD alertes + configuration des chats Telegram + filtres utilisateur.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.alerts import (
    Alert,
    AlertChannel,
    AlertEvent,
    AlertPriority,
    AlertStatus,
    AlertType,
    ChatConfig,
    alert_engine,
    emit_alert,
    get_telegram_bot,
)
from app.db.database import get_db
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# SCHEMAS PYDANTIC
# ══════════════════════════════════════════════════════════════════════════════

class AlertResponse(BaseModel):
    id:           str
    alert_type:   str
    priority:     str
    symbol:       str
    timeframe:    str
    title:        str
    message:      str
    emoji:        str
    payload:      dict[str, Any]
    channels:     list[str]
    status:       str
    created_at:   datetime
    sent_at:      Optional[datetime]

    model_config = {"from_attributes": True}


class AlertListResponse(BaseModel):
    total:   int
    alerts:  list[AlertResponse]
    page:    int
    limit:   int


class AlertStatsResponse(BaseModel):
    total_events:     int
    total_suppressed: int
    total_sent:       int
    total_errors:     int
    queue_size:       int
    processed:        int
    failed:           int
    dead_letter:      int
    history_size:     int
    cache_size:       int


class EmitAlertRequest(BaseModel):
    alert_type: AlertType
    symbol:     str                   = Field(..., min_length=1, max_length=20)
    timeframe:  str                   = Field(..., pattern=r"^(M1|M5|M15|M30|H1|H2|H4|H8|D1|W1|MN1|--)$")
    payload:    dict[str, Any]        = Field(default_factory=dict)
    source:     str                   = "api_manual"

    @field_validator("symbol")
    @classmethod
    def upper_symbol(cls, v: str) -> str:
        return v.upper().strip()


class EmitAlertResponse(BaseModel):
    success:    bool
    alert_id:   Optional[str]
    suppressed: bool
    message:    str


class PriceAlertCreateRequest(BaseModel):
    symbol:    str   = Field(..., min_length=1, max_length=20)
    threshold: float = Field(..., gt=0)
    direction: str   = Field(..., pattern=r"^(above|below)$")
    label:     str   = Field(default="", max_length=100)

    @field_validator("symbol")
    @classmethod
    def upper_symbol(cls, v: str) -> str:
        return v.upper().strip()


class PriceAlertResponse(BaseModel):
    id:        str
    symbol:    str
    threshold: float
    direction: str
    label:     str
    active:    bool
    created_at: datetime


class TelegramChatRegisterRequest(BaseModel):
    chat_id:              str  = Field(..., min_length=1)
    name:                 str  = Field(default="", max_length=100)
    min_priority:         AlertPriority = AlertPriority.MEDIUM
    symbol_whitelist:     list[str]     = Field(default_factory=list)
    timeframe_whitelist:  list[str]     = Field(default_factory=list)
    alert_type_blacklist: list[str]     = Field(default_factory=list)
    silent_hours_start:   int           = Field(default=0, ge=0, le=23)
    silent_hours_end:     int           = Field(default=0, ge=0, le=23)


class TelegramChatResponse(BaseModel):
    chat_id:              str
    name:                 str
    active:               bool
    min_priority:         str
    symbol_whitelist:     list[str]
    timeframe_whitelist:  list[str]
    alert_type_blacklist: list[str]
    silent_hours:         tuple[int, int]


class TelegramChatUpdateRequest(BaseModel):
    name:                 Optional[str]          = None
    active:               Optional[bool]         = None
    min_priority:         Optional[AlertPriority] = None
    symbol_whitelist:     Optional[list[str]]    = None
    timeframe_whitelist:  Optional[list[str]]    = None
    alert_type_blacklist: Optional[list[str]]    = None
    silent_hours_start:   Optional[int]          = Field(default=None, ge=0, le=23)
    silent_hours_end:     Optional[int]          = Field(default=None, ge=0, le=23)


class AlertFilterUpdateRequest(BaseModel):
    symbols_to_add:       list[str]       = Field(default_factory=list)
    symbols_to_remove:    list[str]       = Field(default_factory=list)
    types_to_disable:     list[AlertType] = Field(default_factory=list)
    types_to_enable:      list[AlertType] = Field(default_factory=list)


class AlertFilterStatusResponse(BaseModel):
    symbol_filters:   list[str]
    disabled_types:   list[str]


class DeadLetterResponse(BaseModel):
    total:  int
    alerts: list[AlertResponse]


class TestAlertRequest(BaseModel):
    chat_id:   Optional[str] = None
    symbol:    str           = "BTCUSDT"
    timeframe: str           = "H4"


# ══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def _alert_to_response(alert: Alert) -> AlertResponse:
    return AlertResponse(
        id         = alert.id,
        alert_type = alert.alert_type.value,
        priority   = alert.priority.value,
        symbol     = alert.symbol,
        timeframe  = alert.timeframe,
        title      = alert.title,
        message    = alert.message,
        emoji      = alert.emoji,
        payload    = alert.payload,
        channels   = [c.value for c in alert.channels],
        status     = alert.status.value,
        created_at = alert.created_at,
        sent_at    = alert.sent_at,
    )


def _chat_to_response(cfg: ChatConfig) -> TelegramChatResponse:
    return TelegramChatResponse(
        chat_id              = cfg.chat_id,
        name                 = cfg.name,
        active               = cfg.active,
        min_priority         = cfg.min_priority.value,
        symbol_whitelist     = list(cfg.symbol_whitelist),
        timeframe_whitelist  = list(cfg.timeframe_whitelist),
        alert_type_blacklist = list(cfg.alert_type_blacklist),
        silent_hours         = cfg.silent_hours,
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — HISTORIQUE DES ALERTES
# ══════════════════════════════════════════════════════════════════════════════

@router.get(
    "/history",
    response_model=AlertListResponse,
    summary="Historique des alertes",
    description="Retourne l'historique paginé des alertes avec filtres optionnels.",
)
async def get_alert_history(
    symbol:     Optional[str]          = Query(None, description="Filtrer par symbole ex: BTCUSDT"),
    alert_type: Optional[AlertType]    = Query(None, description="Filtrer par type d'alerte"),
    priority:   Optional[AlertPriority] = Query(None, description="Filtrer par priorité"),
    since:      Optional[datetime]     = Query(None, description="Depuis cette date ISO 8601"),
    limit:      int                    = Query(50,  ge=1, le=500, description="Nombre max de résultats"),
    page:       int                    = Query(1,   ge=1, description="Page"),
):
    all_alerts = alert_engine.get_history(
        symbol     = symbol,
        alert_type = alert_type,
        priority   = priority,
        since      = since,
        limit      = limit * page,   # récupère plus pour paginer
    )
    # Pagination manuelle
    start  = (page - 1) * limit
    end    = start + limit
    paged  = all_alerts[start:end]

    return AlertListResponse(
        total  = len(all_alerts),
        alerts = [_alert_to_response(a) for a in paged],
        page   = page,
        limit  = limit,
    )


@router.get(
    "/history/{alert_id}",
    response_model=AlertResponse,
    summary="Détail d'une alerte",
)
async def get_alert_by_id(alert_id: str):
    all_alerts = alert_engine.get_history(limit=500)
    for alert in all_alerts:
        if alert.id == alert_id:
            return _alert_to_response(alert)
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Alerte {alert_id} introuvable dans l'historique.",
    )


@router.get(
    "/history/symbol/{symbol}",
    response_model=AlertListResponse,
    summary="Historique des alertes pour un symbole",
)
async def get_alerts_by_symbol(
    symbol: str,
    limit:  int = Query(100, ge=1, le=500),
    page:   int = Query(1, ge=1),
):
    alerts = alert_engine.get_history(symbol=symbol.upper(), limit=limit * page)
    start  = (page - 1) * limit
    paged  = alerts[start: start + limit]
    return AlertListResponse(
        total  = len(alerts),
        alerts = [_alert_to_response(a) for a in paged],
        page   = page,
        limit  = limit,
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — ÉMISSION MANUELLE
# ══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/emit",
    response_model=EmitAlertResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Émettre une alerte manuellement",
    description="Déclenche une alerte manuellement — utile pour tests et intégrations externes.",
)
async def emit_alert_manual(body: EmitAlertRequest):
    alert = await emit_alert(
        alert_type = body.alert_type,
        symbol     = body.symbol,
        timeframe  = body.timeframe,
        payload    = body.payload,
        source     = body.source,
    )
    if alert is None:
        return EmitAlertResponse(
            success    = False,
            alert_id   = None,
            suppressed = True,
            message    = "Alerte supprimée par le gestionnaire de déduplication (cooldown actif).",
        )
    return EmitAlertResponse(
        success    = True,
        alert_id   = alert.id,
        suppressed = False,
        message    = f"Alerte {alert.id} mise en queue avec succès.",
    )


@router.post(
    "/test",
    response_model=EmitAlertResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Envoyer une alerte de test",
    description="Envoie une alerte SETUP_VALID fictive pour tester les intégrations Telegram/WebSocket.",
)
async def send_test_alert(body: TestAlertRequest):
    alert = await emit_alert(
        alert_type = AlertType.SETUP_VALID,
        symbol     = body.symbol.upper(),
        timeframe  = body.timeframe,
        payload    = {
            "score":          88,
            "pa_pattern":     "THREE_DRIVES",
            "pa_strength":    95,
            "setup_status":   "VALID",
            "zone_top":       1.23456,
            "zone_bot":       1.23100,
            "zone_type":      "DEMAND",
            "base_type":      "RBR",
            "base_score":     82,
            "sl":             1.22800,
            "tp":             1.25500,
            "entry":          1.23200,
            "rr":             3.2,
            "market_phase":   "RALLY",
            "swing_structure": "HH/HL",
            "checklist": {
                "SB confirmé":   True,
                "SDE englobé":   True,
                "SGB créé":      True,
                "SDP tenu":      True,
                "PA actif":      True,
                "DP aligné":     True,
                "KL confluence": True,
            },
            "score_breakdown": {
                "Base":      "20/20",
                "SDE":       "20/20",
                "SDP":       "18/20",
                "PA":        "19/20",
                "DP/KL":     "11/20",
            },
            "_test": True,
        },
        source = "api_test",
    )
    if alert is None:
        return EmitAlertResponse(
            success=False, alert_id=None, suppressed=True,
            message="Alerte de test supprimée par le cooldown. Attendez 5 minutes ou désactivez le cooldown.",
        )
    return EmitAlertResponse(
        success=True, alert_id=alert.id, suppressed=False,
        message=f"Alerte de test {alert.id} envoyée avec succès.",
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — STATISTIQUES
# ══════════════════════════════════════════════════════════════════════════════

@router.get(
    "/stats",
    response_model=AlertStatsResponse,
    summary="Statistiques du moteur d'alertes",
)
async def get_alert_stats():
    stats = alert_engine.stats
    return AlertStatsResponse(**stats)


@router.get(
    "/dead-letter",
    response_model=DeadLetterResponse,
    summary="Alertes en dead-letter queue",
    description="Alertes qui ont échoué après tous les retries.",
)
async def get_dead_letter():
    dead = alert_engine._queue.get_dead_letter()
    return DeadLetterResponse(
        total  = len(dead),
        alerts = [_alert_to_response(a) for a in dead],
    )


@router.delete(
    "/dead-letter",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Vider la dead-letter queue",
)
async def clear_dead_letter():
    alert_engine._queue._dead_letter.clear()


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — FILTRES DU MOTEUR
# ══════════════════════════════════════════════════════════════════════════════

@router.get(
    "/filters",
    response_model=AlertFilterStatusResponse,
    summary="Filtres actifs du moteur",
)
async def get_filters():
    return AlertFilterStatusResponse(
        symbol_filters = list(alert_engine._symbol_filters),
        disabled_types = [t.value for t in alert_engine._disabled_types],
    )


@router.patch(
    "/filters",
    response_model=AlertFilterStatusResponse,
    summary="Modifier les filtres du moteur",
)
async def update_filters(body: AlertFilterUpdateRequest):
    for sym in body.symbols_to_add:
        alert_engine.add_symbol_filter(sym.upper())
    for sym in body.symbols_to_remove:
        alert_engine.remove_symbol_filter(sym.upper())
    for at in body.types_to_disable:
        alert_engine.disable_alert_type(at)
    for at in body.types_to_enable:
        alert_engine.enable_alert_type(at)

    return AlertFilterStatusResponse(
        symbol_filters = list(alert_engine._symbol_filters),
        disabled_types = [t.value for t in alert_engine._disabled_types],
    )


@router.delete(
    "/filters/symbols",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Vider les filtres de symboles",
)
async def clear_symbol_filters():
    alert_engine._symbol_filters.clear()


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — TELEGRAM CHATS
# ══════════════════════════════════════════════════════════════════════════════

@router.get(
    "/telegram/chats",
    response_model=list[TelegramChatResponse],
    summary="Lister les chats Telegram configurés",
)
async def list_telegram_chats():
    bot = get_telegram_bot()
    if not bot:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Bot Telegram non initialisé.",
        )
    return [_chat_to_response(c) for c in bot.chat_manager.get_all()]


@router.post(
    "/telegram/chats",
    response_model=TelegramChatResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Enregistrer un chat Telegram",
)
async def register_telegram_chat(body: TelegramChatRegisterRequest):
    bot = get_telegram_bot()
    if not bot:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Bot Telegram non initialisé.",
        )
    cfg = ChatConfig(
        chat_id              = body.chat_id,
        name                 = body.name,
        active               = True,
        min_priority         = body.min_priority,
        symbol_whitelist     = set(s.upper() for s in body.symbol_whitelist),
        timeframe_whitelist  = set(body.timeframe_whitelist),
        alert_type_blacklist = set(body.alert_type_blacklist),
        silent_hours         = (body.silent_hours_start, body.silent_hours_end),
    )
    bot.chat_manager.register(cfg)
    log.info("telegram_chat_registered_via_api", chat_id=body.chat_id)
    return _chat_to_response(cfg)


@router.get(
    "/telegram/chats/{chat_id}",
    response_model=TelegramChatResponse,
    summary="Détail d'un chat Telegram",
)
async def get_telegram_chat(chat_id: str):
    bot = get_telegram_bot()
    if not bot:
        raise HTTPException(status_code=503, detail="Bot Telegram non initialisé.")
    chats = {c.chat_id: c for c in bot.chat_manager.get_all()}
    if chat_id not in chats:
        raise HTTPException(status_code=404, detail=f"Chat {chat_id} introuvable.")
    return _chat_to_response(chats[chat_id])


@router.patch(
    "/telegram/chats/{chat_id}",
    response_model=TelegramChatResponse,
    summary="Modifier la configuration d'un chat Telegram",
)
async def update_telegram_chat(chat_id: str, body: TelegramChatUpdateRequest):
    bot = get_telegram_bot()
    if not bot:
        raise HTTPException(status_code=503, detail="Bot Telegram non initialisé.")

    updates: dict[str, Any] = {}
    if body.name               is not None: updates["name"]                 = body.name
    if body.active             is not None: updates["active"]               = body.active
    if body.min_priority       is not None: updates["min_priority"]         = body.min_priority
    if body.symbol_whitelist   is not None: updates["symbol_whitelist"]     = set(s.upper() for s in body.symbol_whitelist)
    if body.timeframe_whitelist is not None: updates["timeframe_whitelist"] = set(body.timeframe_whitelist)
    if body.alert_type_blacklist is not None: updates["alert_type_blacklist"] = set(body.alert_type_blacklist)
    if body.silent_hours_start is not None or body.silent_hours_end is not None:
        chats = {c.chat_id: c for c in bot.chat_manager.get_all()}
        if chat_id in chats:
            old = chats[chat_id].silent_hours
            new_s = body.silent_hours_start if body.silent_hours_start is not None else old[0]
            new_e = body.silent_hours_end   if body.silent_hours_end   is not None else old[1]
            updates["silent_hours"] = (new_s, new_e)

    ok = bot.chat_manager.update_config(chat_id, **updates)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Chat {chat_id} introuvable.")

    chats = {c.chat_id: c for c in bot.chat_manager.get_all()}
    return _chat_to_response(chats[chat_id])


@router.delete(
    "/telegram/chats/{chat_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Supprimer un chat Telegram",
)
async def delete_telegram_chat(chat_id: str):
    bot = get_telegram_bot()
    if not bot:
        raise HTTPException(status_code=503, detail="Bot Telegram non initialisé.")
    bot.chat_manager.unregister(chat_id)


@router.patch(
    "/telegram/chats/{chat_id}/toggle",
    response_model=TelegramChatResponse,
    summary="Activer / désactiver un chat Telegram",
)
async def toggle_telegram_chat(chat_id: str, active: bool = Query(...)):
    bot = get_telegram_bot()
    if not bot:
        raise HTTPException(status_code=503, detail="Bot Telegram non initialisé.")
    bot.chat_manager.set_active(chat_id, active)
    chats = {c.chat_id: c for c in bot.chat_manager.get_all()}
    if chat_id not in chats:
        raise HTTPException(status_code=404, detail=f"Chat {chat_id} introuvable.")
    return _chat_to_response(chats[chat_id])


@router.post(
    "/telegram/chats/{chat_id}/test",
    response_model=EmitAlertResponse,
    summary="Envoyer un message de test à un chat spécifique",
)
async def test_telegram_chat(chat_id: str, background_tasks: BackgroundTasks):
    bot = get_telegram_bot()
    if not bot:
        raise HTTPException(status_code=503, detail="Bot Telegram non initialisé.")

    async def _send():
        await bot.send_text(
            chat_id=chat_id,
            text=(
                "🔥 *Test IGNIS Platform*\n\n"
                "✅ La connexion Telegram fonctionne correctement\\.\n"
                "Vous recevrez les alertes S&D sur ce chat\\."
            ),
        )

    background_tasks.add_task(_send)
    return EmitAlertResponse(
        success=True, alert_id=None, suppressed=False,
        message=f"Message de test envoyé au chat {chat_id}.",
    )


@router.post(
    "/telegram/broadcast",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Diffuser un message à tous les chats actifs",
)
async def broadcast_message(
    text:       str  = Query(..., min_length=1, max_length=4096),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    bot = get_telegram_bot()
    if not bot:
        raise HTTPException(status_code=503, detail="Bot Telegram non initialisé.")

    async def _broadcast():
        for chat in bot.chat_manager.get_all():
            if chat.active:
                await bot.send_text(chat.chat_id, text, silent=True)

    background_tasks.add_task(_broadcast)
    active_count = sum(1 for c in bot.chat_manager.get_all() if c.active)
    return {"message": f"Broadcast lancé vers {active_count} chats actifs."}


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — ALERTES DE PRIX UTILISATEUR
# ══════════════════════════════════════════════════════════════════════════════

# Stockage en mémoire (à remplacer par DB en prod)
_price_alerts: dict[str, dict] = {}


@router.get(
    "/price",
    response_model=list[PriceAlertResponse],
    summary="Lister les alertes de prix",
)
async def list_price_alerts(symbol: Optional[str] = Query(None)):
    alerts = list(_price_alerts.values())
    if symbol:
        alerts = [a for a in alerts if a["symbol"] == symbol.upper()]
    return [PriceAlertResponse(**a) for a in alerts]


@router.post(
    "/price",
    response_model=PriceAlertResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Créer une alerte de prix",
)
async def create_price_alert(body: PriceAlertCreateRequest):
    alert_id = str(uuid4())
    record = {
        "id":         alert_id,
        "symbol":     body.symbol,
        "threshold":  body.threshold,
        "direction":  body.direction,
        "label":      body.label,
        "active":     True,
        "created_at": datetime.now(timezone.utc),
    }
    _price_alerts[alert_id] = record
    log.info("price_alert_created", **{k: v for k, v in record.items() if k != "created_at"})
    return PriceAlertResponse(**record)


@router.delete(
    "/price/{alert_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Supprimer une alerte de prix",
)
async def delete_price_alert(alert_id: str):
    if alert_id not in _price_alerts:
        raise HTTPException(status_code=404, detail=f"Alerte de prix {alert_id} introuvable.")
    del _price_alerts[alert_id]


@router.patch(
    "/price/{alert_id}/toggle",
    response_model=PriceAlertResponse,
    summary="Activer / désactiver une alerte de prix",
)
async def toggle_price_alert(alert_id: str, active: bool = Query(...)):
    if alert_id not in _price_alerts:
        raise HTTPException(status_code=404, detail=f"Alerte de prix {alert_id} introuvable.")
    _price_alerts[alert_id]["active"] = active
    return PriceAlertResponse(**_price_alerts[alert_id])


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — TYPES ET MÉTADONNÉES
# ══════════════════════════════════════════════════════════════════════════════

@router.get(
    "/types",
    summary="Lister tous les types d'alertes disponibles",
)
async def get_alert_types():
    from app.alerts.alert_engine import ALERT_PRIORITY_MAP, ALERT_EMOJI_MAP, ALERT_COOLDOWNS
    return [
        {
            "value":    at.value,
            "priority": ALERT_PRIORITY_MAP.get(at, AlertPriority.LOW).value,
            "emoji":    ALERT_EMOJI_MAP.get(at, "ℹ️"),
            "cooldown": ALERT_COOLDOWNS.get(at, 60),
        }
        for at in AlertType
    ]


@router.get(
    "/priorities",
    summary="Lister les niveaux de priorité",
)
async def get_priorities():
    from app.alerts.alert_engine import PRIORITY_CHANNELS_MAP
    return [
        {
            "value":    p.value,
            "channels": [c.value for c in PRIORITY_CHANNELS_MAP.get(p, [])],
        }
        for p in AlertPriority
    ]