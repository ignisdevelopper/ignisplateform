"""
routes_assets.py — Routes API actifs IGNIS
Gestion de la watchlist + statut de setup par actif (HLZ / S&D).

Objectifs :
- Lister les actifs suivis (watchlist)
- Ajouter / supprimer / modifier un actif
- Exposer un "Setup Snapshot" (status/score/zone/rr) basé sur le dernier cache d'analyse
- Déclencher un refresh (background) du pipeline d'analyse pour la watchlist

Notes :
- Stockage watchlist : in-memory (fallback). En prod, basculer vers DB (SQLAlchemy).
- Snapshot setup : on tente de lire le cache "analysis:{symbol}:{timeframe}:{limit}".
  Si absent : status = "WATCH" + score = 0.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app import ASSET_CLASSES, CACHE_CONFIG, PAPattern, SetupStatus, ZoneType
from app.db.database import get_db
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# MODELS / STORE (in-memory fallback)
# ══════════════════════════════════════════════════════════════════════════════

class AssetSource(str, Enum):
    BINANCE = "BINANCE"
    YAHOO   = "YAHOO"
    MANUAL  = "MANUAL"


@dataclass
class AssetRecord:
    id:          str
    symbol:      str
    asset_class: str  # "CRYPTO" | "FOREX" | ...
    name:        str = ""
    source:      AssetSource = AssetSource.MANUAL
    exchange:    str = ""
    enabled:     bool = True
    tags:        set[str] = None
    created_at:  datetime = None
    updated_at:  datetime = None

    def __post_init__(self) -> None:
        if self.tags is None:
            self.tags = set()
        if self.created_at is None:
            self.created_at = datetime.now(timezone.utc)
        if self.updated_at is None:
            self.updated_at = self.created_at


# Watchlist en mémoire (fallback)
_ASSETS: dict[str, AssetRecord] = {}


def _seed_defaults() -> None:
    """Seed minimal pour éviter une watchlist vide au premier run."""
    if _ASSETS:
        return
    for sym, cls_, src in [
        ("BTCUSDT", "CRYPTO", AssetSource.BINANCE),
        ("ETHUSDT", "CRYPTO", AssetSource.BINANCE),
        ("EURUSD",  "FOREX",  AssetSource.YAHOO),
        ("XAUUSD",  "COMMODITIES", AssetSource.YAHOO),
    ]:
        rec = AssetRecord(
            id=str(uuid4()),
            symbol=sym,
            asset_class=cls_,
            source=src,
            name=sym,
            exchange="",
            enabled=True,
            tags=set(),
        )
        _ASSETS[rec.symbol] = rec


_seed_defaults()


# ══════════════════════════════════════════════════════════════════════════════
# PYDANTIC SCHEMAS
# ══════════════════════════════════════════════════════════════════════════════

class AssetCreateRequest(BaseModel):
    symbol:      str        = Field(..., min_length=1, max_length=20)
    asset_class: str        = Field(..., description=f"Une des classes: {list(ASSET_CLASSES.keys())}")
    name:        str        = Field(default="", max_length=100)
    source:      AssetSource = AssetSource.MANUAL
    exchange:    str        = Field(default="", max_length=50)
    enabled:     bool       = True
    tags:        list[str]  = Field(default_factory=list)

    @field_validator("symbol")
    @classmethod
    def _upper_symbol(cls, v: str) -> str:
        return v.upper().strip()

    @field_validator("asset_class")
    @classmethod
    def _validate_class(cls, v: str) -> str:
        v = v.upper().strip()
        if v not in ASSET_CLASSES:
            raise ValueError(f"asset_class invalide. Valeurs acceptées : {list(ASSET_CLASSES.keys())}")
        return v


class AssetUpdateRequest(BaseModel):
    name:        Optional[str] = Field(default=None, max_length=100)
    exchange:    Optional[str] = Field(default=None, max_length=50)
    enabled:     Optional[bool] = None
    tags:        Optional[list[str]] = None
    asset_class: Optional[str] = None
    source:      Optional[AssetSource] = None

    @field_validator("asset_class")
    @classmethod
    def _validate_class(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.upper().strip()
        if v not in ASSET_CLASSES:
            raise ValueError(f"asset_class invalide. Valeurs acceptées : {list(ASSET_CLASSES.keys())}")
        return v


class SetupSnapshot(BaseModel):
    timeframe:     str
    setup_status:  str
    score:         int
    pa_pattern:    str
    zone_type:     Optional[str] = None
    zone_top:      Optional[float] = None
    zone_bot:      Optional[float] = None
    entry:         Optional[float] = None
    sl:            Optional[float] = None
    tp:            Optional[float] = None
    rr:            Optional[float] = None
    analyzed_at:   Optional[datetime] = None
    from_cache:    bool = True


class AssetResponse(BaseModel):
    id:          str
    symbol:      str
    asset_class: str
    name:        str
    source:      str
    exchange:    str
    enabled:     bool
    tags:        list[str]
    created_at:  datetime
    updated_at:  datetime

    setup:       Optional[SetupSnapshot] = None

    model_config = {"from_attributes": True}


class AssetListResponse(BaseModel):
    total:  int
    page:   int
    limit:  int
    assets: list[AssetResponse]


class RefreshRequest(BaseModel):
    symbols:    Optional[list[str]] = None
    timeframe:  str = Field(default="H4", description="TF utilisée pour recalculer le snapshot setup")
    candle_limit: int = Field(default=500, ge=50, le=5000)
    include_ltf:  bool = False

    @field_validator("symbols")
    @classmethod
    def _upper_syms(cls, v: Optional[list[str]]) -> Optional[list[str]]:
        if v is None:
            return None
        return [s.upper().strip() for s in v if s and s.strip()]


class RefreshResponse(BaseModel):
    queued:   int
    symbols:  list[str]
    message:  str


class AssetStatsResponse(BaseModel):
    total_assets: int
    enabled:      int
    disabled:     int
    by_class:     dict[str, int]
    updated_at:   datetime


# ══════════════════════════════════════════════════════════════════════════════
# HELPERS — serialization + cache snapshot
# ══════════════════════════════════════════════════════════════════════════════

def _asset_to_response(asset: AssetRecord, setup: Optional[SetupSnapshot] = None) -> AssetResponse:
    return AssetResponse(
        id=asset.id,
        symbol=asset.symbol,
        asset_class=asset.asset_class,
        name=asset.name,
        source=asset.source.value,
        exchange=asset.exchange,
        enabled=asset.enabled,
        tags=sorted(list(asset.tags)),
        created_at=asset.created_at,
        updated_at=asset.updated_at,
        setup=setup,
    )


def _guess_source(symbol: str, asset_class: str) -> AssetSource:
    """
    Heuristique simple :
    - CRYPTO → BINANCE
    - sinon → YAHOO
    """
    if asset_class == "CRYPTO":
        return AssetSource.BINANCE
    return AssetSource.YAHOO


async def _get_cached_analysis_snapshot(
    symbol: str,
    timeframe: str,
    candle_limits: tuple[int, ...] = (500, 300, 1000, 2000),
) -> Optional[dict[str, Any]]:
    """
    Tente de récupérer une AnalysisResponse (ou dict) depuis le cache, sans connaître le candle_limit exact.
    On essaie plusieurs limites "standard".
    """
    from app.data.cache_manager import CacheManager

    cache = CacheManager()

    for lim in candle_limits:
        key = f"analysis:{symbol}:{timeframe}:{lim}"
        try:
            cached = await cache.get(key)
        except Exception:
            cached = None
        if cached:
            return cached
    return None


def _safe_get(d: Any, path: list[str], default: Any = None) -> Any:
    """
    Accès tolerant :
    - dict nested
    - pydantic models (attr access)
    """
    cur = d
    for k in path:
        if cur is None:
            return default
        if isinstance(cur, dict):
            cur = cur.get(k)
        else:
            cur = getattr(cur, k, None)
    return cur if cur is not None else default


def _build_setup_snapshot_from_analysis(
    analysis_obj: Any,
    timeframe: str,
    from_cache: bool = True,
) -> SetupSnapshot:
    """
    Construit un snapshot minimal depuis AnalysisResponse (pydantic) ou dict.
    """
    setup_status = _safe_get(analysis_obj, ["setup", "status"], SetupStatus.WATCH)
    if hasattr(setup_status, "value"):  # Enum/pydantic
        setup_status = setup_status.value

    score = int(_safe_get(analysis_obj, ["setup", "score"], 0) or 0)

    # Best zone / best PA (on prend [0])
    best_zone_type = _safe_get(analysis_obj, ["sd_zones", 0, "zone_type"], None)  # dict won't work with int index
    # Pour gérer list index sur dict/pydantic : on tente différemment
    zones = _safe_get(analysis_obj, ["sd_zones"], []) or []
    pas   = _safe_get(analysis_obj, ["pa_patterns"], []) or []

    zone_type = None
    zone_top = zone_bot = None
    if zones and isinstance(zones, list):
        z0 = zones[0]
        zt = _safe_get(z0, ["zone_type"], None)
        if hasattr(zt, "value"):
            zt = zt.value
        zone_type = zt
        zone_top = _safe_get(z0, ["zone_top"], None)
        zone_bot = _safe_get(z0, ["zone_bot"], None)

    pa_pattern = PAPattern.NONE
    if pas and isinstance(pas, list):
        p0 = pas[0]
        pat = _safe_get(p0, ["pattern"], PAPattern.NONE)
        if hasattr(pat, "value"):
            pat = pat.value
        pa_pattern = pat

    sltp = _safe_get(analysis_obj, ["sl_tp"], None)
    entry = _safe_get(sltp, ["entry"], None)
    sl    = _safe_get(sltp, ["stop_loss"], None)
    tp    = _safe_get(sltp, ["take_profit"], None)
    rr    = _safe_get(sltp, ["rr"], None)

    analyzed_at = _safe_get(analysis_obj, ["analyzed_at"], None)

    # Convert possible strings to datetime? Keep as-is if already datetime.
    if isinstance(analyzed_at, str):
        try:
            analyzed_at = datetime.fromisoformat(analyzed_at.replace("Z", "+00:00"))
        except Exception:
            analyzed_at = None

    return SetupSnapshot(
        timeframe=timeframe,
        setup_status=str(setup_status),
        score=score,
        pa_pattern=str(pa_pattern),
        zone_type=zone_type,
        zone_top=zone_top,
        zone_bot=zone_bot,
        entry=entry,
        sl=sl,
        tp=tp,
        rr=rr,
        analyzed_at=analyzed_at,
        from_cache=from_cache,
    )


async def _get_setup_snapshot(
    symbol: str,
    timeframe: str,
    auto_analyze: bool = False,
    candle_limit: int = 500,
    include_ltf: bool = False,
    background_tasks: Optional[BackgroundTasks] = None,
) -> SetupSnapshot:
    """
    Snapshot = lecture cache ; si absent et auto_analyze=True, on queue un refresh pipeline.
    """
    symbol = symbol.upper().strip()
    timeframe = timeframe.upper().strip()

    cached = await _get_cached_analysis_snapshot(symbol, timeframe)
    if cached:
        return _build_setup_snapshot_from_analysis(cached, timeframe=timeframe, from_cache=True)

    if auto_analyze and background_tasks is not None:
        # On déclenche un refresh asynchrone (sans bloquer la requête)
        async def _run():
            try:
                from app.core.setup_scanner.setup_pipeline import SetupPipeline
                from app.data.binance_fetcher import BinanceFetcher
                from app.data.yahoo_fetcher import YahooFetcher
                from app.data.data_normalizer import DataNormalizer
                from app.data.cache_manager import CacheManager

                normalizer = DataNormalizer()
                if symbol.endswith("USDT") or symbol.endswith("BTC"):
                    fetcher = BinanceFetcher()
                    raw = await fetcher.fetch_ohlcv(symbol, timeframe, limit=candle_limit)
                else:
                    fetcher = YahooFetcher()
                    raw = await fetcher.fetch_ohlcv(symbol, timeframe, limit=candle_limit)

                candles = normalizer.normalize(raw, timeframe)
                pipeline = SetupPipeline()
                result = await pipeline.run(
                    candles=candles,
                    symbol=symbol,
                    timeframe=timeframe,
                    higher_tf=None,
                    include_ltf=include_ltf,
                )

                # Stocker en cache avec la même convention que routes_analysis
                from app.api.routes_analysis import AnalysisResponse  # type: ignore
                resp = AnalysisResponse(
                    symbol=symbol,
                    timeframe=timeframe,
                    higher_tf=None,
                    analyzed_at=datetime.now(timezone.utc),
                    candles_used=len(candles),
                    duration_ms=0,
                    from_cache=False,
                    market_structure=result.market_structure,
                    bases=result.bases,
                    sd_zones=result.sd_zones,
                    pa_patterns=result.pa_patterns,
                    advanced=result.advanced,
                    decision_points=result.decision_points,
                    key_levels=result.key_levels,
                    sl_tp=result.sl_tp,
                    setup=result.setup,
                    candles=None,
                    ai_report=None,
                    ai_summary=None,
                )
                cache = CacheManager()
                await cache.set(
                    f"analysis:{symbol}:{timeframe}:{candle_limit}",
                    resp,
                    ttl=CACHE_CONFIG["ANALYSIS_TTL"],
                )
            except Exception as exc:
                log.warning("asset_auto_analyze_failed", symbol=symbol, timeframe=timeframe, error=str(exc))

        background_tasks.add_task(_run)

    # Fallback snapshot
    return SetupSnapshot(
        timeframe=timeframe,
        setup_status=SetupStatus.WATCH,
        score=0,
        pa_pattern=PAPattern.NONE,
        zone_type=None,
        zone_top=None,
        zone_bot=None,
        entry=None,
        sl=None,
        tp=None,
        rr=None,
        analyzed_at=None,
        from_cache=True,
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — LISTE / CRUD WATCHLIST
# ══════════════════════════════════════════════════════════════════════════════

@router.get(
    "",
    response_model=AssetListResponse,
    summary="Lister les actifs (watchlist) + snapshot setup HLZ",
)
async def list_assets(
    asset_class: Optional[str] = Query(None, description="Filtrer par classe (CRYPTO/FOREX/...)"),
    enabled: Optional[bool] = Query(None, description="Filtrer actifs activés/désactivés"),
    symbols: Optional[str] = Query(None, description="Liste séparée par virgule: BTCUSDT,ETHUSDT"),
    timeframe: str = Query("H4", description="TF pour le snapshot setup"),
    include_setup: bool = Query(True, description="Inclure snapshot setup (cache)"),
    auto_analyze: bool = Query(False, description="Si cache absent, déclenche une analyse background"),
    candle_limit: int = Query(500, ge=50, le=5000),
    include_ltf: bool = Query(False, description="Si auto_analyze, inclure analyse LTF"),
    sort: str = Query("symbol", pattern=r"^(symbol|class|updated_at|score)$"),
    order: str = Query("asc", pattern=r"^(asc|desc)$"),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=500),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    db: AsyncSession = Depends(get_db),
):
    _ = db  # réservé DB (prod)

    cls_filter = asset_class.upper().strip() if asset_class else None
    if cls_filter and cls_filter not in ASSET_CLASSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"asset_class invalide. Valeurs acceptées : {list(ASSET_CLASSES.keys())}",
        )

    symbol_list: Optional[list[str]] = None
    if symbols:
        symbol_list = [s.upper().strip() for s in symbols.split(",") if s.strip()]

    items = list(_ASSETS.values())

    if cls_filter:
        items = [a for a in items if a.asset_class == cls_filter]
    if enabled is not None:
        items = [a for a in items if a.enabled == enabled]
    if symbol_list:
        wanted = set(symbol_list)
        items = [a for a in items if a.symbol in wanted]

    # Snapshot setup (async gather)
    setups: dict[str, SetupSnapshot] = {}
    if include_setup and items:
        snaps = await asyncio.gather(*[
            _get_setup_snapshot(
                symbol=a.symbol,
                timeframe=timeframe,
                auto_analyze=auto_analyze,
                candle_limit=candle_limit,
                include_ltf=include_ltf,
                background_tasks=background_tasks,
            )
            for a in items
        ])
        setups = {a.symbol: s for a, s in zip(items, snaps)}

    def _sort_key(asset: AssetRecord):
        if sort == "symbol":
            return asset.symbol
        if sort == "class":
            return asset.asset_class
        if sort == "updated_at":
            return asset.updated_at
        if sort == "score":
            return setups.get(asset.symbol, SetupSnapshot(timeframe=timeframe, setup_status="WATCH", score=0, pa_pattern="NONE")).score
        return asset.symbol

    reverse = (order == "desc")
    items.sort(key=_sort_key, reverse=reverse)

    start = (page - 1) * limit
    paged = items[start : start + limit]

    return AssetListResponse(
        total=len(items),
        page=page,
        limit=limit,
        assets=[
            _asset_to_response(a, setup=setups.get(a.symbol))
            for a in paged
        ],
    )


@router.get(
    "/{symbol}",
    response_model=AssetResponse,
    summary="Détail d'un actif + snapshot setup",
)
async def get_asset(
    symbol: str,
    timeframe: str = Query("H4"),
    include_setup: bool = Query(True),
    auto_analyze: bool = Query(False),
    candle_limit: int = Query(500, ge=50, le=5000),
    include_ltf: bool = Query(False),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    db: AsyncSession = Depends(get_db),
):
    _ = db
    symbol = symbol.upper().strip()
    asset = _ASSETS.get(symbol)
    if not asset:
        raise HTTPException(status_code=404, detail=f"Actif {symbol} introuvable.")

    setup = None
    if include_setup:
        setup = await _get_setup_snapshot(
            symbol=symbol,
            timeframe=timeframe,
            auto_analyze=auto_analyze,
            candle_limit=candle_limit,
            include_ltf=include_ltf,
            background_tasks=background_tasks,
        )

    return _asset_to_response(asset, setup=setup)


@router.post(
    "",
    response_model=AssetResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Ajouter un actif à la watchlist",
)
async def create_asset(
    body: AssetCreateRequest,
    timeframe: str = Query("H4"),
    include_setup: bool = Query(False),
    db: AsyncSession = Depends(get_db),
):
    _ = db
    symbol = body.symbol
    if symbol in _ASSETS:
        raise HTTPException(status_code=409, detail=f"Actif {symbol} déjà présent dans la watchlist.")

    src = body.source
    if src == AssetSource.MANUAL:
        src = _guess_source(symbol, body.asset_class)

    rec = AssetRecord(
        id=str(uuid4()),
        symbol=symbol,
        asset_class=body.asset_class,
        name=body.name or symbol,
        source=src,
        exchange=body.exchange,
        enabled=body.enabled,
        tags=set(t.strip() for t in body.tags if t and t.strip()),
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    _ASSETS[rec.symbol] = rec

    setup = None
    if include_setup:
        setup = await _get_setup_snapshot(symbol=symbol, timeframe=timeframe)

    log.info("asset_created", symbol=rec.symbol, asset_class=rec.asset_class, source=rec.source.value)
    return _asset_to_response(rec, setup=setup)


@router.patch(
    "/{symbol}",
    response_model=AssetResponse,
    summary="Modifier un actif",
)
async def update_asset(
    symbol: str,
    body: AssetUpdateRequest,
    timeframe: str = Query("H4"),
    include_setup: bool = Query(False),
    db: AsyncSession = Depends(get_db),
):
    _ = db
    symbol = symbol.upper().strip()
    asset = _ASSETS.get(symbol)
    if not asset:
        raise HTTPException(status_code=404, detail=f"Actif {symbol} introuvable.")

    if body.name is not None:
        asset.name = body.name
    if body.exchange is not None:
        asset.exchange = body.exchange
    if body.enabled is not None:
        asset.enabled = body.enabled
    if body.tags is not None:
        asset.tags = set(t.strip() for t in body.tags if t and t.strip())
    if body.asset_class is not None:
        asset.asset_class = body.asset_class
    if body.source is not None:
        asset.source = body.source

    asset.updated_at = datetime.now(timezone.utc)

    setup = None
    if include_setup:
        setup = await _get_setup_snapshot(symbol=symbol, timeframe=timeframe)

    log.info("asset_updated", symbol=symbol)
    return _asset_to_response(asset, setup=setup)


@router.delete(
    "/{symbol}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Supprimer un actif de la watchlist",
)
async def delete_asset(
    symbol: str,
    db: AsyncSession = Depends(get_db),
):
    _ = db
    symbol = symbol.upper().strip()
    if symbol not in _ASSETS:
        raise HTTPException(status_code=404, detail=f"Actif {symbol} introuvable.")
    del _ASSETS[symbol]
    log.info("asset_deleted", symbol=symbol)


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — STATS / HEALTH
# ══════════════════════════════════════════════════════════════════════════════

@router.get(
    "/stats",
    response_model=AssetStatsResponse,
    summary="Statistiques watchlist",
)
async def get_assets_stats(db: AsyncSession = Depends(get_db)):
    _ = db
    items = list(_ASSETS.values())
    by_class: dict[str, int] = {}
    for a in items:
        by_class[a.asset_class] = by_class.get(a.asset_class, 0) + 1
    enabled_count = sum(1 for a in items if a.enabled)
    disabled_count = len(items) - enabled_count

    latest_update = max((a.updated_at for a in items), default=datetime.now(timezone.utc))

    return AssetStatsResponse(
        total_assets=len(items),
        enabled=enabled_count,
        disabled=disabled_count,
        by_class=by_class,
        updated_at=latest_update,
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — REFRESH (pipeline HLZ)
# ══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/refresh",
    response_model=RefreshResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Déclencher un refresh du pipeline pour la watchlist",
    description=(
        "Met en queue une analyse S&D (SetupPipeline) pour les symboles demandés. "
        "Le résultat est stocké en cache (analysis:{symbol}:{tf}:{limit})."
    ),
)
async def refresh_assets(
    body: RefreshRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    _ = db
    timeframe = body.timeframe.upper().strip()

    if body.symbols:
        symbols = body.symbols
    else:
        symbols = [a.symbol for a in _ASSETS.values() if a.enabled]

    if not symbols:
        return RefreshResponse(queued=0, symbols=[], message="Aucun symbole à rafraîchir (watchlist vide ou tout désactivé).")

    async def _refresh_one(sym: str) -> None:
        sym = sym.upper().strip()
        try:
            from app.core.setup_scanner.setup_pipeline import SetupPipeline
            from app.data.binance_fetcher import BinanceFetcher
            from app.data.yahoo_fetcher import YahooFetcher
            from app.data.data_normalizer import DataNormalizer
            from app.data.cache_manager import CacheManager

            normalizer = DataNormalizer()
            if sym.endswith("USDT") or sym.endswith("BTC"):
                fetcher = BinanceFetcher()
                raw = await fetcher.fetch_ohlcv(sym, timeframe, limit=body.candle_limit)
            else:
                fetcher = YahooFetcher()
                raw = await fetcher.fetch_ohlcv(sym, timeframe, limit=body.candle_limit)

            candles = normalizer.normalize(raw, timeframe)
            pipeline = SetupPipeline()
            result = await pipeline.run(
                candles=candles,
                symbol=sym,
                timeframe=timeframe,
                higher_tf=None,
                include_ltf=body.include_ltf,
            )

            # Import local pour éviter couplage fort
            from app.api.routes_analysis import AnalysisResponse  # type: ignore

            resp = AnalysisResponse(
                symbol=sym,
                timeframe=timeframe,
                higher_tf=None,
                analyzed_at=datetime.now(timezone.utc),
                candles_used=len(candles),
                duration_ms=0,
                from_cache=False,
                market_structure=result.market_structure,
                bases=result.bases,
                sd_zones=result.sd_zones,
                pa_patterns=result.pa_patterns,
                advanced=result.advanced,
                decision_points=result.decision_points,
                key_levels=result.key_levels,
                sl_tp=result.sl_tp,
                setup=result.setup,
                candles=None,
                ai_report=None,
                ai_summary=None,
            )

            cache = CacheManager()
            await cache.set(
                f"analysis:{sym}:{timeframe}:{body.candle_limit}",
                resp,
                ttl=CACHE_CONFIG["ANALYSIS_TTL"],
            )

            log.info("asset_refresh_done", symbol=sym, timeframe=timeframe)

        except Exception as exc:
            log.warning("asset_refresh_failed", symbol=sym, timeframe=timeframe, error=str(exc))

    async def _refresh_all() -> None:
        # Limite de concurrence pour éviter d'exploser l'API provider
        sem = asyncio.Semaphore(5)

        async def _guarded(sym: str):
            async with sem:
                await _refresh_one(sym)

        await asyncio.gather(*[_guarded(s) for s in symbols])

    background_tasks.add_task(_refresh_all)

    return RefreshResponse(
        queued=len(symbols),
        symbols=symbols,
        message=f"Refresh lancé en background pour {len(symbols)} symboles sur {timeframe}.",
    )
