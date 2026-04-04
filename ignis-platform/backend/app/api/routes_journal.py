"""
routes_journal.py — Routes API Journal IGNIS
CRUD pour journal de trades (entrées, sorties, notes, tags, stats simples).

Base path (via api/__init__.py):
/api/v1/journal/...

Notes:
- Ce fichier utilise SQLAlchemy AsyncSession (get_db).
- Import du modèle DB en lazy import pour éviter de casser l'import si le modèle
  n'est pas encore finalisé dans app/db/models.py.
  -> Attendu: un modèle "JournalEntry" (ou compatible) avec des champs usuels.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional, Literal
from uuid import uuid4
import importlib

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# LAZY IMPORT MODEL
# ══════════════════════════════════════════════════════════════════════════════

def _get_journal_model():
    """
    Retourne (JournalEntryModel, model_name).
    Attendu dans app.db.models : class JournalEntry(Base)
    """
    try:
        m = importlib.import_module("app.db.models")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"DB models indisponibles: {exc}",
        )

    Model = getattr(m, "JournalEntry", None)
    if Model is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Modèle DB 'JournalEntry' introuvable dans app.db.models. "
                   "Crée-le ou adapte _get_journal_model().",
        )
    return Model


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ══════════════════════════════════════════════════════════════════════════════
# Pydantic Schemas
# ══════════════════════════════════════════════════════════════════════════════

Side = Literal["LONG", "SHORT"]
TradeStatus = Literal["OPEN", "CLOSED", "CANCELLED", "BREAKEVEN"]


class JournalCreateRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=20)
    timeframe: str = Field(default="H4", min_length=1, max_length=10)

    side: Side
    entry: float = Field(..., gt=0)
    sl: Optional[float] = Field(default=None, gt=0)
    tp: Optional[float] = Field(default=None, gt=0)

    rr: Optional[float] = Field(default=None, gt=0)
    size: Optional[float] = Field(default=None, gt=0, description="Taille (lots/qty), optionnel")

    setup_id: Optional[str] = Field(default=None, max_length=64)
    setup_score: Optional[int] = Field(default=None, ge=0, le=100)

    opened_at: Optional[datetime] = None
    notes: str = Field(default="", max_length=5000)
    tags: list[str] = Field(default_factory=list, max_items=30)

    @field_validator("symbol")
    @classmethod
    def _upper_symbol(cls, v: str) -> str:
        return v.upper().strip()

    @field_validator("timeframe")
    @classmethod
    def _upper_tf(cls, v: str) -> str:
        return v.upper().strip()

    @field_validator("tags")
    @classmethod
    def _clean_tags(cls, v: list[str]) -> list[str]:
        return sorted({t.strip() for t in v if t and t.strip()})


class JournalUpdateRequest(BaseModel):
    timeframe: Optional[str] = Field(default=None, min_length=1, max_length=10)
    side: Optional[Side] = None

    entry: Optional[float] = Field(default=None, gt=0)
    sl: Optional[float] = Field(default=None, gt=0)
    tp: Optional[float] = Field(default=None, gt=0)
    rr: Optional[float] = Field(default=None, gt=0)
    size: Optional[float] = Field(default=None, gt=0)

    setup_id: Optional[str] = Field(default=None, max_length=64)
    setup_score: Optional[int] = Field(default=None, ge=0, le=100)

    status: Optional[TradeStatus] = None

    opened_at: Optional[datetime] = None
    closed_at: Optional[datetime] = None
    exit_price: Optional[float] = Field(default=None, gt=0)

    pnl: Optional[float] = None
    pnl_pct: Optional[float] = None

    notes: Optional[str] = Field(default=None, max_length=5000)
    tags: Optional[list[str]] = Field(default=None, max_items=30)

    @field_validator("timeframe")
    @classmethod
    def _upper_tf(cls, v: Optional[str]) -> Optional[str]:
        return v.upper().strip() if v else v

    @field_validator("tags")
    @classmethod
    def _clean_tags(cls, v: Optional[list[str]]) -> Optional[list[str]]:
        if v is None:
            return None
        return sorted({t.strip() for t in v if t and t.strip()})


class JournalCloseRequest(BaseModel):
    exit_price: float = Field(..., gt=0)
    closed_at: Optional[datetime] = None
    pnl: Optional[float] = None
    pnl_pct: Optional[float] = None
    notes_append: str = Field(default="", max_length=2000)


class JournalEntryResponse(BaseModel):
    id: str
    symbol: str
    timeframe: str
    side: str

    entry: float
    sl: Optional[float]
    tp: Optional[float]
    rr: Optional[float]
    size: Optional[float]

    status: str

    setup_id: Optional[str]
    setup_score: Optional[int]

    opened_at: Optional[datetime]
    closed_at: Optional[datetime]
    exit_price: Optional[float]

    pnl: Optional[float]
    pnl_pct: Optional[float]

    notes: str
    tags: list[str]

    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class JournalListResponse(BaseModel):
    total: int
    page: int
    limit: int
    items: list[JournalEntryResponse]


class JournalStatsResponse(BaseModel):
    total: int
    open: int
    closed: int
    cancelled: int
    breakeven: int


# ══════════════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════════════

def _model_to_response(obj: Any) -> JournalEntryResponse:
    # lecture tolérante (si le modèle a des noms légèrement différents)
    def g(name: str, default=None):
        return getattr(obj, name, default)

    tags = g("tags", []) or []
    if isinstance(tags, str):
        # si stocké en CSV/texte
        tags = [t.strip() for t in tags.split(",") if t.strip()]

    return JournalEntryResponse(
        id=str(g("id")),
        symbol=g("symbol", ""),
        timeframe=g("timeframe", ""),
        side=g("side", ""),

        entry=float(g("entry", 0.0)),
        sl=g("sl"),
        tp=g("tp"),
        rr=g("rr"),
        size=g("size"),

        status=g("status", "OPEN"),

        setup_id=g("setup_id"),
        setup_score=g("setup_score"),

        opened_at=g("opened_at"),
        closed_at=g("closed_at"),
        exit_price=g("exit_price"),

        pnl=g("pnl"),
        pnl_pct=g("pnl_pct"),

        notes=g("notes", "") or "",
        tags=list(tags),

        created_at=g("created_at") or _now_utc(),
        updated_at=g("updated_at") or _now_utc(),
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES
# ══════════════════════════════════════════════════════════════════════════════

@router.get(
    "/",
    response_model=JournalListResponse,
    summary="Lister les entrées du journal",
)
async def list_journal_entries(
    db: AsyncSession = Depends(get_db),

    symbol: Optional[str] = Query(None, description="Filtre symbole (ex: BTCUSDT)"),
    status_: Optional[TradeStatus] = Query(None, alias="status", description="OPEN/CLOSED/..."),
    side: Optional[Side] = Query(None),

    since: Optional[datetime] = Query(None, description="Filtre created_at >= since (ISO)"),
    until: Optional[datetime] = Query(None, description="Filtre created_at <= until (ISO)"),

    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=500),
):
    JournalEntry = _get_journal_model()

    q = select(JournalEntry)
    if symbol:
        q = q.where(JournalEntry.symbol == symbol.upper().strip())
    if status_:
        q = q.where(JournalEntry.status == status_)
    if side:
        q = q.where(JournalEntry.side == side)
    if since:
        q = q.where(JournalEntry.created_at >= since)
    if until:
        q = q.where(JournalEntry.created_at <= until)

    # total
    q_total = select(func.count()).select_from(q.subquery())
    total = (await db.execute(q_total)).scalar_one()

    # pagination
    q = q.order_by(desc(JournalEntry.created_at)).offset((page - 1) * limit).limit(limit)
    rows = (await db.execute(q)).scalars().all()

    return JournalListResponse(
        total=total,
        page=page,
        limit=limit,
        items=[_model_to_response(r) for r in rows],
    )


@router.get(
    "/stats",
    response_model=JournalStatsResponse,
    summary="Stats simples du journal",
)
async def journal_stats(
    db: AsyncSession = Depends(get_db),
    symbol: Optional[str] = Query(None),
):
    JournalEntry = _get_journal_model()

    base = select(JournalEntry.status, func.count()).group_by(JournalEntry.status)
    if symbol:
        base = base.where(JournalEntry.symbol == symbol.upper().strip())

    rows = (await db.execute(base)).all()
    counts = {status: n for status, n in rows}

    return JournalStatsResponse(
        total=sum(counts.values()),
        open=int(counts.get("OPEN", 0)),
        closed=int(counts.get("CLOSED", 0)),
        cancelled=int(counts.get("CANCELLED", 0)),
        breakeven=int(counts.get("BREAKEVEN", 0)),
    )


@router.post(
    "/",
    response_model=JournalEntryResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Créer une entrée de journal",
)
async def create_journal_entry(
    body: JournalCreateRequest,
    db: AsyncSession = Depends(get_db),
):
    JournalEntry = _get_journal_model()

    entry_id = str(uuid4())
    created = JournalEntry(
        id=entry_id,
        symbol=body.symbol,
        timeframe=body.timeframe,
        side=body.side,
        entry=body.entry,
        sl=body.sl,
        tp=body.tp,
        rr=body.rr,
        size=body.size,
        status="OPEN",
        setup_id=body.setup_id,
        setup_score=body.setup_score,
        opened_at=body.opened_at,
        notes=body.notes,
        tags=body.tags,
        created_at=_now_utc(),
        updated_at=_now_utc(),
    )
    db.add(created)
    await db.commit()
    await db.refresh(created)

    log.info("journal_entry_created", id=entry_id, symbol=body.symbol, timeframe=body.timeframe)
    return _model_to_response(created)


@router.get(
    "/{entry_id}",
    response_model=JournalEntryResponse,
    summary="Récupérer une entrée par id",
)
async def get_journal_entry(
    entry_id: str,
    db: AsyncSession = Depends(get_db),
):
    JournalEntry = _get_journal_model()
    obj = await db.get(JournalEntry, entry_id)
    if not obj:
        raise HTTPException(status_code=404, detail=f"Journal entry {entry_id} introuvable.")
    return _model_to_response(obj)


@router.patch(
    "/{entry_id}",
    response_model=JournalEntryResponse,
    summary="Mettre à jour une entrée",
)
async def update_journal_entry(
    entry_id: str,
    body: JournalUpdateRequest,
    db: AsyncSession = Depends(get_db),
):
    JournalEntry = _get_journal_model()
    obj = await db.get(JournalEntry, entry_id)
    if not obj:
        raise HTTPException(status_code=404, detail=f"Journal entry {entry_id} introuvable.")

    updates = body.model_dump(exclude_unset=True)

    # normalisations
    if "timeframe" in updates and updates["timeframe"]:
        updates["timeframe"] = updates["timeframe"].upper().strip()

    # tags
    if "tags" in updates and updates["tags"] is not None:
        updates["tags"] = sorted({t.strip() for t in updates["tags"] if t and t.strip()})

    for k, v in updates.items():
        setattr(obj, k, v)

    obj.updated_at = _now_utc()

    await db.commit()
    await db.refresh(obj)

    log.info("journal_entry_updated", id=entry_id)
    return _model_to_response(obj)


@router.post(
    "/{entry_id}/close",
    response_model=JournalEntryResponse,
    summary="Clôturer un trade (close)",
)
async def close_journal_entry(
    entry_id: str,
    body: JournalCloseRequest,
    db: AsyncSession = Depends(get_db),
):
    JournalEntry = _get_journal_model()
    obj = await db.get(JournalEntry, entry_id)
    if not obj:
        raise HTTPException(status_code=404, detail=f"Journal entry {entry_id} introuvable.")

    # update fields
    obj.exit_price = body.exit_price
    obj.closed_at = body.closed_at or _now_utc()
    obj.status = "CLOSED"
    if body.pnl is not None:
        obj.pnl = body.pnl
    if body.pnl_pct is not None:
        obj.pnl_pct = body.pnl_pct

    if body.notes_append:
        existing = getattr(obj, "notes", "") or ""
        sep = "\n\n" if existing else ""
        obj.notes = f"{existing}{sep}{body.notes_append}".strip()

    obj.updated_at = _now_utc()

    await db.commit()
    await db.refresh(obj)

    log.info("journal_entry_closed", id=entry_id, exit_price=body.exit_price)
    return _model_to_response(obj)


@router.delete(
    "/{entry_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Supprimer une entrée",
)
async def delete_journal_entry(
    entry_id: str,
    db: AsyncSession = Depends(get_db),
):
    JournalEntry = _get_journal_model()
    obj = await db.get(JournalEntry, entry_id)
    if not obj:
        raise HTTPException(status_code=404, detail=f"Journal entry {entry_id} introuvable.")

    await db.delete(obj)
    await db.commit()

    log.info("journal_entry_deleted", id=entry_id)
    return None