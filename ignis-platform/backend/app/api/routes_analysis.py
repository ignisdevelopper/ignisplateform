"""
routes_analysis.py — Routes API analyse S&D IGNIS
Pipeline complet d'analyse Supply & Demand pour un symbole/timeframe.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from app import (
    TIMEFRAMES,
    TIMEFRAME_HIERARCHY,
    BaseType,
    DPType,
    MarketPhase,
    PAPattern,
    SetupStatus,
    ZoneType,
    SCORING_THRESHOLDS,
)
from app.alerts import AlertType, emit_alert
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# SCHEMAS — REQUÊTES
# ══════════════════════════════════════════════════════════════════════════════

class AnalysisRequest(BaseModel):
    symbol:          str        = Field(..., min_length=1, max_length=20)
    timeframe:       str        = Field(..., pattern=r"^(M1|M5|M15|M30|H1|H2|H4|H8|D1|W1|MN1)$")
    higher_tf:       Optional[str] = Field(None, description="Timeframe HTF pour confluence")
    candle_limit:    int        = Field(500, ge=50, le=5000)
    force_refresh:   bool       = Field(False, description="Ignore le cache et re-fetch les données")
    include_ltf:     bool       = Field(False, description="Inclure analyse LTF pour hidden bases")
    include_ai:      bool       = Field(False, description="Inclure rapport Ignis AI (Ollama)")

    @field_validator("symbol")
    @classmethod
    def upper_symbol(cls, v: str) -> str:
        return v.upper().strip()

    @field_validator("higher_tf")
    @classmethod
    def validate_higher_tf(cls, v: Optional[str], info) -> Optional[str]:
        if v is None:
            return v
        valid = list(TIMEFRAMES.keys())
        if v not in valid:
            raise ValueError(f"higher_tf invalide. Valeurs acceptées : {valid}")
        return v


class MultiAnalysisRequest(BaseModel):
    symbols:       list[str]   = Field(..., min_length=1, max_length=50)
    timeframe:     str         = Field("H4", pattern=r"^(M1|M5|M15|M30|H1|H2|H4|H8|D1|W1|MN1)$")
    candle_limit:  int         = Field(300, ge=50, le=2000)
    valid_only:    bool        = Field(False, description="Retourner seulement les setups VALID")

    @field_validator("symbols")
    @classmethod
    def upper_symbols(cls, v: list[str]) -> list[str]:
        return [s.upper().strip() for s in v]


class ScannerRequest(BaseModel):
    symbols:        list[str]   = Field(..., min_length=1, max_length=50)
    timeframes:     list[str]   = Field(default=["H4", "D1"])
    min_score:      int         = Field(0, ge=0, le=100)
    status_filter:  list[str]   = Field(default_factory=list)
    pa_filter:      list[str]   = Field(default_factory=list)
    candle_limit:   int         = Field(300, ge=50, le=2000)

    @field_validator("symbols")
    @classmethod
    def upper_symbols(cls, v: list[str]) -> list[str]:
        return [s.upper().strip() for s in v]


# ══════════════════════════════════════════════════════════════════════════════
# SCHEMAS — RÉPONSES
# ══════════════════════════════════════════════════════════════════════════════

class CandleSchema(BaseModel):
    timestamp:  int
    open:       float
    high:       float
    low:        float
    close:      float
    volume:     float
    timeframe:  str


class SwingPoint(BaseModel):
    timestamp:   int
    price:       float
    swing_type:  str   # "HH" | "HL" | "LH" | "LL"
    index:       int


class MarketStructureResult(BaseModel):
    phase:            str
    trend:            str                    # "BULLISH" | "BEARISH" | "RANGING"
    swing_points:     list[SwingPoint]
    last_hh:          Optional[float]
    last_hl:          Optional[float]
    last_lh:          Optional[float]
    last_ll:          Optional[float]
    structure_breaks: list[dict[str, Any]]
    htf_phase:        Optional[str]  # Phase du HTF si fourni
    htf_bias:         Optional[str]          # "BULLISH" | "BEARISH" | "NEUTRAL"


class BaseResult(BaseModel):
    id:              str
    base_type:       BaseType
    zone_top:        float
    zone_bot:        float
    score:           int
    is_solid:        bool
    is_weakening:    bool
    is_hidden:       bool
    touch_count:     int
    candle_count:    int
    formed_at:       int     # timestamp
    timeframe:       str
    engulfment_ratio: float


class SDZoneResult(BaseModel):
    id:             str
    zone_type:      ZoneType
    base:           BaseResult
    zone_top:       float
    zone_bot:       float
    sde_confirmed:  bool
    sde_score:      int
    sgb_created:    bool
    sdp_validated:  bool
    sdp_head:       Optional[float]
    ftb_count:      int
    is_ftb_valid:   bool
    is_flippy:      bool
    is_failed:      bool
    formed_at:      int
    timeframe:      str
    score:          int


class PAResult(BaseModel):
    pattern:         PAPattern
    detected:        bool
    strength:        int
    description:     str
    confirmation_ts: Optional[int]
    drives:          Optional[list[float]]    # Pour 3 Drives
    trend_line:      Optional[dict]           # Pour FTL
    details:         dict[str, Any]


class DPResult(BaseModel):
    dp_type:       DPType
    price:         float
    zone_top:      float
    zone_bot:      float
    confirmed:     bool
    description:   str
    timeframe:     str


class KeyLevelResult(BaseModel):
    price:       float
    level_type:  str    # "OLD_HIGH" | "OLD_LOW" | "ROUND_NUMBER" | "SR_FLIP"
    strength:    int
    description: str


class SLTPResult(BaseModel):
    entry:       float
    stop_loss:   float
    take_profit: float
    rr:          float
    risk_pips:   float
    reward_pips: float
    position:    str    # "LONG" | "SHORT"


class AdvancedPatternResult(BaseModel):
    over_under:     Optional[dict[str, Any]]
    iou:            Optional[dict[str, Any]]
    flag_limit:     Optional[dict[str, Any]]
    counter_attack: Optional[dict[str, Any]]
    ignored_accu:   Optional[dict[str, Any]]


class SetupScoreBreakdown(BaseModel):
    base_score:      int
    sde_score:       int
    sdp_score:       int
    pa_score:        int
    dp_score:        int
    kl_score:        int
    structure_score: int
    total:           int


class SetupResult(BaseModel):
    status:          SetupStatus
    score:           int
    score_breakdown: SetupScoreBreakdown
    checklist:       dict[str, bool]
    invalidation_reason: Optional[str]
    pending_step:    Optional[str]


class AnalysisResponse(BaseModel):
    # Méta
    symbol:         str
    timeframe:      str
    higher_tf:      Optional[str]
    analyzed_at:    datetime
    candles_used:   int
    duration_ms:    int
    from_cache:     bool

    # Résultats S&D
    market_structure: MarketStructureResult
    bases:            list[BaseResult]
    sd_zones:         list[SDZoneResult]
    pa_patterns:      list[PAResult]
    advanced:         AdvancedPatternResult
    decision_points:  list[DPResult]
    key_levels:       list[KeyLevelResult]
    sl_tp:            Optional[SLTPResult]
    setup:            SetupResult

    # Données brutes (optionnel)
    candles:          Optional[list[CandleSchema]]

    # IA
    ai_report:        Optional[str]
    ai_summary:       Optional[str]


class AnalysisSummary(BaseModel):
    """Version allégée pour les listes / scanner."""
    symbol:          str
    timeframe:       str
    setup_status:    SetupStatus
    score:           int
    pa_pattern:      PAPattern
    zone_type:       Optional[ZoneType]
    zone_top:        Optional[float]
    zone_bot:        Optional[float]
    sl:              Optional[float]
    tp:              Optional[float]
    rr:              Optional[float]
    market_phase: str
    analyzed_at:     datetime


class MultiAnalysisResponse(BaseModel):
    total:     int
    results:   list[AnalysisSummary]
    errors:    dict[str, str]
    duration_ms: int


class ScannerResult(BaseModel):
    symbol:       str
    timeframe:    str
    setup_status: SetupStatus
    score:        int
    pa_pattern:   PAPattern
    zone_type:    Optional[ZoneType]
    zone_top:     Optional[float]
    zone_bot:     Optional[float]
    entry:        Optional[float]
    sl:           Optional[float]
    tp:           Optional[float]
    rr:           Optional[float]
    market_phase: str
    checklist:    dict[str, bool]
    analyzed_at:  datetime


class ScannerResponse(BaseModel):
    total:        int
    valid_count:  int
    pending_count: int
    results:      list[ScannerResult]
    duration_ms:  int


class MTFAnalysisResponse(BaseModel):
    symbol:      str
    timeframes:  list[str]
    analyses:    dict[str, AnalysisSummary]
    htf_bias:    str
    confluence:  bool
    analyzed_at: datetime


class ZoneHistoryResponse(BaseModel):
    symbol:      str
    timeframe:   str
    zones:       list[SDZoneResult]
    total:       int
    active:      int
    expired:     int
    flippy:      int


class BacktestRequest(BaseModel):
    symbol:       str   = Field(..., min_length=1, max_length=20)
    timeframe:    str   = Field("H4")
    from_date:    datetime
    to_date:      datetime
    min_score:    int   = Field(70, ge=0, le=100)
    min_rr:       float = Field(2.0, ge=0.5)

    @field_validator("symbol")
    @classmethod
    def upper_symbol(cls, v: str) -> str:
        return v.upper().strip()


class BacktestTradeResult(BaseModel):
    symbol:      str
    timeframe:   str
    entry_ts:    int
    exit_ts:     int
    entry_price: float
    exit_price:  float
    sl:          float
    tp:          float
    rr:          float
    result:      str    # "WIN" | "LOSS" | "BREAKEVEN"
    pnl_pct:     float
    setup_score: int
    pa_pattern:  str


class BacktestResponse(BaseModel):
    symbol:        str
    timeframe:     str
    from_date:     datetime
    to_date:       datetime
    total_trades:  int
    wins:          int
    losses:        int
    winrate:       float
    avg_rr:        float
    total_pnl_pct: float
    max_drawdown:  float
    trades:        list[BacktestTradeResult]


# ══════════════════════════════════════════════════════════════════════════════
# HELPERS — PIPELINE (stub vers les modules core)
# ══════════════════════════════════════════════════════════════════════════════

async def _run_analysis_pipeline(
    symbol:        str,
    timeframe:     str,
    higher_tf:     Optional[str],
    candle_limit:  int,
    force_refresh: bool,
    include_ltf:   bool,
    include_ai:    bool,
) -> tuple[AnalysisResponse, bool]:
    """
    Orchestre le pipeline complet d'analyse S&D.
    Délègue à setup_pipeline.py (core) — stub ici pour la route.
    Retourne (AnalysisResponse, from_cache).
    """
    from app.core.setup_scanner.setup_pipeline import SetupPipeline
    from app.data.binance_fetcher import BinanceFetcher
    from app.data.yahoo_fetcher import YahooFetcher
    from app.data.data_normalizer import DataNormalizer
    from app.data.cache_manager import CacheManager

    t_start = asyncio.get_event_loop().time()

    cache   = CacheManager()
    cache_key = f"analysis:{symbol}:{timeframe}:{candle_limit}"

    # Cache check
    if not force_refresh:
        cached = await cache.get(cache_key)
        if cached:
            log.debug("analysis_cache_hit", symbol=symbol, timeframe=timeframe)
            return cached, True

    # Fetch candles
    normalizer = DataNormalizer()
    try:
        if symbol.endswith("USDT") or symbol.endswith("BTC"):
            fetcher  = BinanceFetcher()
            raw      = await fetcher.fetch_ohlcv(symbol, timeframe, limit=candle_limit)
        else:
            fetcher  = YahooFetcher()
            raw      = await fetcher.fetch_ohlcv(symbol, timeframe, limit=candle_limit)
        candles = normalizer.normalize(raw, timeframe)
    except Exception as exc:
        log.error("candle_fetch_failed", symbol=symbol, timeframe=timeframe, error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Impossible de récupérer les données pour {symbol}/{timeframe}: {str(exc)}",
        )

    if len(candles) < 50:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Données insuffisantes pour {symbol}/{timeframe}: {len(candles)} bougies (min 50).",
        )

    # Pipeline S&D complet
    pipeline = SetupPipeline()
    result   = await pipeline.run(
        candles      = candles,
        symbol       = symbol,
        timeframe    = timeframe,
        higher_tf    = higher_tf,
        include_ltf  = include_ltf,
    )

    # Rapport IA optionnel
    ai_report  = None
    ai_summary = None
    if include_ai:
        try:
            from app.ignis_ai.report_generator import ReportGenerator
            gen        = ReportGenerator()
            ai_report  = await gen.generate(result, symbol, timeframe)
            ai_summary = await gen.summarize(result)
        except Exception as exc:
            log.warning("ai_report_failed", error=str(exc))

    duration_ms = int((asyncio.get_event_loop().time() - t_start) * 1000)

    response = AnalysisResponse(
        symbol           = symbol,
        timeframe        = timeframe,
        higher_tf        = higher_tf,
        analyzed_at      = datetime.now(timezone.utc),
        candles_used     = len(candles),
        duration_ms      = duration_ms,
        from_cache       = False,
        market_structure = result.market_structure,
        bases            = result.bases,
        sd_zones         = result.sd_zones,
        pa_patterns      = result.pa_patterns,
        advanced         = result.advanced,
        decision_points  = result.decision_points,
        key_levels       = result.key_levels,
        sl_tp            = result.sl_tp,
        setup            = result.setup,
        candles          = None,
        ai_report        = ai_report,
        ai_summary       = ai_summary,
    )

    # Mise en cache
    from app import CACHE_CONFIG
    await cache.set(cache_key, response, ttl=CACHE_CONFIG["ANALYSIS_TTL"])

    return response, False


def _to_summary(resp: AnalysisResponse) -> AnalysisSummary:
    best_zone = resp.sd_zones[0] if resp.sd_zones else None
    best_pa   = resp.pa_patterns[0] if resp.pa_patterns else None
    return AnalysisSummary(
        symbol       = resp.symbol,
        timeframe    = resp.timeframe,
        setup_status = resp.setup.status,
        score        = resp.setup.score,
        pa_pattern   = best_pa.pattern if best_pa else PAPattern.NONE,
        zone_type    = best_zone.zone_type if best_zone else None,
        zone_top     = best_zone.zone_top  if best_zone else None,
        zone_bot     = best_zone.zone_bot  if best_zone else None,
        sl           = resp.sl_tp.stop_loss   if resp.sl_tp else None,
        tp           = resp.sl_tp.take_profit if resp.sl_tp else None,
        rr           = resp.sl_tp.rr          if resp.sl_tp else None,
        market_phase = resp.market_structure.phase,
        analyzed_at  = resp.analyzed_at,
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — ANALYSE PRINCIPALE
# ══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/{symbol}",
    response_model=AnalysisResponse,
    status_code=status.HTTP_200_OK,
    summary="Analyse S&D complète d'un actif",
    description=(
        "Lance le pipeline complet Supply & Demand sur un symbole/timeframe : "
        "Market Structure → Base Detection → SDE/SGB/SDP → PA Patterns → "
        "Advanced Patterns → Decision Point → Setup Scoring."
    ),
)
async def analyze_symbol(
    symbol:         str,
    body:           AnalysisRequest,
    background_tasks: BackgroundTasks,
):
    body.symbol = symbol.upper()

    log.info(
        "analysis_requested",
        symbol=body.symbol,
        timeframe=body.timeframe,
        include_ai=body.include_ai,
    )

    response, from_cache = await _run_analysis_pipeline(
        symbol        = body.symbol,
        timeframe     = body.timeframe,
        higher_tf     = body.higher_tf,
        candle_limit  = body.candle_limit,
        force_refresh = body.force_refresh,
        include_ltf   = body.include_ltf,
        include_ai    = body.include_ai,
    )
    response.from_cache = from_cache

    # Émettre une alerte si setup VALID
    if response.setup.status == SetupStatus.VALID:
        background_tasks.add_task(
            emit_alert,
            alert_type = AlertType.SETUP_VALID,
            symbol     = body.symbol,
            timeframe  = body.timeframe,
            payload    = {
                "score":          response.setup.score,
                "pa_pattern":     response.pa_patterns[0].pattern.value if response.pa_patterns else "NONE",
                "pa_strength":    response.pa_patterns[0].strength if response.pa_patterns else 0,
                "setup_status":   response.setup.status,
                "zone_top":       response.sd_zones[0].zone_top if response.sd_zones else 0,
                "zone_bot":       response.sd_zones[0].zone_bot if response.sd_zones else 0,
                "zone_type":      response.sd_zones[0].zone_type.value if response.sd_zones else "",
                "sl":             response.sl_tp.stop_loss   if response.sl_tp else 0,
                "tp":             response.sl_tp.take_profit if response.sl_tp else 0,
                "rr":             response.sl_tp.rr          if response.sl_tp else 0,
                "entry":          response.sl_tp.entry       if response.sl_tp else 0,
                "market_phase":   response.market_structure.phase,
                "checklist":      response.setup.checklist,
                "score_breakdown": response.setup.score_breakdown.model_dump(),
            },
            source = "routes_analysis",
        )

    elif response.setup.status == SetupStatus.PENDING:
        background_tasks.add_task(
            emit_alert,
            alert_type = AlertType.SETUP_PENDING,
            symbol     = body.symbol,
            timeframe  = body.timeframe,
            payload    = {
                "score":        response.setup.score,
                "pending_step": response.setup.pending_step or "En attente",
            },
            source = "routes_analysis",
        )

    return response


@router.get(
    "/{symbol}",
    response_model=AnalysisResponse,
    summary="Analyse S&D (GET rapide)",
    description="Version GET pour intégrations simples. Paramètres via query string.",
)
async def analyze_symbol_get(
    symbol:        str,
    timeframe:     str  = Query("H4", pattern=r"^(M1|M5|M15|M30|H1|H2|H4|H8|D1|W1|MN1)$"),
    higher_tf:     Optional[str]  = Query(None),
    candle_limit:  int  = Query(500, ge=50, le=5000),
    force_refresh: bool = Query(False),
    include_ltf:   bool = Query(False),
    include_ai:    bool = Query(False),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    return await analyze_symbol(
        symbol = symbol,
        body   = AnalysisRequest(
            symbol        = symbol,
            timeframe     = timeframe,
            higher_tf     = higher_tf,
            candle_limit  = candle_limit,
            force_refresh = force_refresh,
            include_ltf   = include_ltf,
            include_ai    = include_ai,
        ),
        background_tasks = background_tasks,
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — ANALYSE MULTI-SYMBOLES
# ══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/batch/multi",
    response_model=MultiAnalysisResponse,
    status_code=status.HTTP_200_OK,
    summary="Analyser plusieurs symboles en parallèle",
    description="Lance l'analyse S&D sur N symboles en parallèle. Max 50 symboles.",
)
async def analyze_multi(body: MultiAnalysisRequest):
    t_start = asyncio.get_event_loop().time()
    errors: dict[str, str] = {}

    async def _safe_analyze(sym: str):
        try:
            resp, _ = await _run_analysis_pipeline(
                symbol        = sym,
                timeframe     = body.timeframe,
                higher_tf     = None,
                candle_limit  = body.candle_limit,
                force_refresh = False,
                include_ltf   = False,
                include_ai    = False,
            )
            return _to_summary(resp)
        except Exception as exc:
            errors[sym] = str(exc)
            return None

    tasks   = [_safe_analyze(sym) for sym in body.symbols]
    results = await asyncio.gather(*tasks)
    summaries = [r for r in results if r is not None]

    if body.valid_only:
        summaries = [s for s in summaries if s.setup_status == SetupStatus.VALID]

    duration_ms = int((asyncio.get_event_loop().time() - t_start) * 1000)

    return MultiAnalysisResponse(
        total       = len(summaries),
        results     = summaries,
        errors      = errors,
        duration_ms = duration_ms,
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — SCANNER
# ══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/batch/scan",
    response_model=ScannerResponse,
    summary="Scanner S&D multi-symboles multi-timeframes",
    description=(
        "Scanne une liste de symboles sur plusieurs timeframes. "
        "Filtre par score minimum, statut de setup et pattern PA."
    ),
)
async def scan_setups(body: ScannerRequest):
    t_start = asyncio.get_event_loop().time()
    scan_results: list[ScannerResult] = []
    errors: dict[str, str] = {}

    async def _scan_one(sym: str, tf: str):
        try:
            resp, _ = await _run_analysis_pipeline(
                symbol        = sym,
                timeframe     = tf,
                higher_tf     = None,
                candle_limit  = body.candle_limit,
                force_refresh = False,
                include_ltf   = False,
                include_ai    = False,
            )
            best_zone = resp.sd_zones[0] if resp.sd_zones else None
            best_pa   = resp.pa_patterns[0] if resp.pa_patterns else None

            result = ScannerResult(
                symbol       = sym,
                timeframe    = tf,
                setup_status = resp.setup.status,
                score        = resp.setup.score,
                pa_pattern   = best_pa.pattern if best_pa else PAPattern.NONE,
                zone_type    = best_zone.zone_type if best_zone else None,
                zone_top     = best_zone.zone_top  if best_zone else None,
                zone_bot     = best_zone.zone_bot  if best_zone else None,
                entry        = resp.sl_tp.entry       if resp.sl_tp else None,
                sl           = resp.sl_tp.stop_loss   if resp.sl_tp else None,
                tp           = resp.sl_tp.take_profit if resp.sl_tp else None,
                rr           = resp.sl_tp.rr          if resp.sl_tp else None,
                market_phase = resp.market_structure.phase,
                checklist    = resp.setup.checklist,
                analyzed_at  = resp.analyzed_at,
            )

            # Filtres
            if result.score < body.min_score:
                return None
            if body.status_filter and result.setup_status.value not in body.status_filter:
                return None
            if body.pa_filter and result.pa_pattern.value not in body.pa_filter:
                return None

            return result

        except Exception as exc:
            errors[f"{sym}/{tf}"] = str(exc)
            return None

    tasks = [
        _scan_one(sym, tf)
        for sym in body.symbols
        for tf  in body.timeframes
    ]
    raw_results = await asyncio.gather(*tasks)
    scan_results = [r for r in raw_results if r is not None]

    # Tri par score décroissant
    scan_results.sort(key=lambda r: r.score, reverse=True)

    valid_count   = sum(1 for r in scan_results if r.setup_status == SetupStatus.VALID)
    pending_count = sum(1 for r in scan_results if r.setup_status == SetupStatus.PENDING)
    duration_ms   = int((asyncio.get_event_loop().time() - t_start) * 1000)

    return ScannerResponse(
        total         = len(scan_results),
        valid_count   = valid_count,
        pending_count = pending_count,
        results       = scan_results,
        duration_ms   = duration_ms,
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — MULTI-TIMEFRAME
# ══════════════════════════════════════════════════════════════════════════════

@router.get(
    "/{symbol}/mtf",
    response_model=MTFAnalysisResponse,
    summary="Analyse multi-timeframe pour un symbole",
    description="Lance l'analyse sur tous les timeframes spécifiés et calcule le biais HTF.",
)
async def analyze_mtf(
    symbol:      str,
    timeframes:  str  = Query("M15,H1,H4,D1", description="TFs séparés par virgule"),
    candle_limit: int = Query(300, ge=50, le=2000),
):
    symbol = symbol.upper()
    tf_list = [tf.strip() for tf in timeframes.split(",") if tf.strip() in TIMEFRAMES]
    if not tf_list:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Aucun timeframe valide fourni. Valeurs acceptées : {list(TIMEFRAMES.keys())}",
        )

    analyses: dict[str, AnalysisSummary] = {}
    errors: dict[str, str] = {}

    async def _analyze_tf(tf: str):
        try:
            resp, _ = await _run_analysis_pipeline(
                symbol=symbol, timeframe=tf,
                higher_tf=None, candle_limit=candle_limit,
                force_refresh=False, include_ltf=False, include_ai=False,
            )
            analyses[tf] = _to_summary(resp)
        except Exception as exc:
            errors[tf] = str(exc)

    await asyncio.gather(*[_analyze_tf(tf) for tf in tf_list])

    # Calcul du biais HTF
    htf_order    = [tf for tf in TIMEFRAME_HIERARCHY if tf in analyses]
    bullish_count = sum(
        1 for tf in htf_order
        if analyses[tf].market_phase == MarketPhase.RALLY
    )
    bearish_count = sum(
        1 for tf in htf_order
        if analyses[tf].market_phase == MarketPhase.DROP
    )
    total_tf  = len(htf_order)
    htf_bias  = (
        "BULLISH" if bullish_count > total_tf * 0.6
        else "BEARISH" if bearish_count > total_tf * 0.6
        else "NEUTRAL"
    )
    confluence = (
        any(a.setup_status == SetupStatus.VALID for a in analyses.values())
        and htf_bias != "NEUTRAL"
    )

    return MTFAnalysisResponse(
        symbol      = symbol,
        timeframes  = tf_list,
        analyses    = analyses,
        htf_bias    = htf_bias,
        confluence  = confluence,
        analyzed_at = datetime.now(timezone.utc),
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — HISTORIQUE DES ZONES
# ══════════════════════════════════════════════════════════════════════════════

@router.get(
    "/{symbol}/zones",
    response_model=ZoneHistoryResponse,
    summary="Historique des zones S&D pour un symbole",
)
async def get_zone_history(
    symbol:    str,
    timeframe: str  = Query("H4"),
    limit:     int  = Query(500, ge=50, le=5000),
):
    symbol = symbol.upper()
    resp, _ = await _run_analysis_pipeline(
        symbol=symbol, timeframe=timeframe,
        higher_tf=None, candle_limit=limit,
        force_refresh=False, include_ltf=True, include_ai=False,
    )
    zones        = resp.sd_zones
    active_count  = sum(1 for z in zones if not z.is_failed and z.ftb_count < 3)
    expired_count = sum(1 for z in zones if z.is_failed or z.ftb_count >= 3)
    flippy_count  = sum(1 for z in zones if z.is_flippy)

    return ZoneHistoryResponse(
        symbol    = symbol,
        timeframe = timeframe,
        zones     = zones,
        total     = len(zones),
        active    = active_count,
        expired   = expired_count,
        flippy    = flippy_count,
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — BACKTEST
# ══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/backtest/run",
    response_model=BacktestResponse,
    summary="Backtest de la stratégie S&D",
    description=(
        "Lance un backtest de la stratégie Supply & Demand sur une période historique. "
        "Simule les entrées sur les setups validés et calcule le winrate/RR réels."
    ),
)
async def run_backtest(body: BacktestRequest):
    from app.core.setup_scanner.setup_pipeline import SetupPipeline
    from app.data.binance_fetcher import BinanceFetcher
    from app.data.yahoo_fetcher import YahooFetcher
    from app.data.data_normalizer import DataNormalizer

    log.info(
        "backtest_started",
        symbol=body.symbol,
        timeframe=body.timeframe,
        from_date=body.from_date.isoformat(),
        to_date=body.to_date.isoformat(),
    )

    normalizer = DataNormalizer()
    try:
        if body.symbol.endswith("USDT") or body.symbol.endswith("BTC"):
            fetcher = BinanceFetcher()
            raw     = await fetcher.fetch_ohlcv_range(
                body.symbol, body.timeframe, body.from_date, body.to_date
            )
        else:
            fetcher = YahooFetcher()
            raw     = await fetcher.fetch_ohlcv_range(
                body.symbol, body.timeframe, body.from_date, body.to_date
            )
        candles = normalizer.normalize(raw, body.timeframe)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Impossible de récupérer les données historiques: {str(exc)}",
        )

    if len(candles) < 100:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Données insuffisantes pour le backtest: {len(candles)} bougies (min 100).",
        )

    pipeline = SetupPipeline()
    trades   = await pipeline.backtest(
        candles   = candles,
        symbol    = body.symbol,
        timeframe = body.timeframe,
        min_score = body.min_score,
        min_rr    = body.min_rr,
    )

    wins      = sum(1 for t in trades if t["result"] == "WIN")
    losses    = sum(1 for t in trades if t["result"] == "LOSS")
    total     = len(trades)
    winrate   = wins / total * 100 if total > 0 else 0.0
    avg_rr    = sum(t["rr"] for t in trades) / total if total > 0 else 0.0
    total_pnl = sum(t["pnl_pct"] for t in trades)

    pnl_curve   = [0.0]
    for t in trades:
        pnl_curve.append(pnl_curve[-1] + t["pnl_pct"])
    max_drawdown = 0.0
    peak = pnl_curve[0]
    for val in pnl_curve:
        if val > peak:
            peak = val
        dd = peak - val
        if dd > max_drawdown:
            max_drawdown = dd

    trade_results = [
        BacktestTradeResult(
            symbol      = body.symbol,
            timeframe   = body.timeframe,
            entry_ts    = t["entry_ts"],
            exit_ts     = t["exit_ts"],
            entry_price = t["entry_price"],
            exit_price  = t["exit_price"],
            sl          = t["sl"],
            tp          = t["tp"],
            rr          = t["rr"],
            result      = t["result"],
            pnl_pct     = t["pnl_pct"],
            setup_score = t["setup_score"],
            pa_pattern  = t["pa_pattern"],
        )
        for t in trades
    ]

    log.info(
        "backtest_completed",
        symbol=body.symbol,
        total=total, wins=wins, losses=losses,
        winrate=round(winrate, 1),
        avg_rr=round(avg_rr, 2),
    )

    return BacktestResponse(
        symbol        = body.symbol,
        timeframe     = body.timeframe,
        from_date     = body.from_date,
        to_date       = body.to_date,
        total_trades  = total,
        wins          = wins,
        losses        = losses,
        winrate       = round(winrate, 2),
        avg_rr        = round(avg_rr, 2),
        total_pnl_pct = round(total_pnl, 2),
        max_drawdown  = round(max_drawdown, 2),
        trades        = trade_results,
    )


# ══════════════════════════════════════════════════════════════════════════════
# ROUTES — INVALIDATION DE CACHE
# ══════════════════════════════════════════════════════════════════════════════

@router.delete(
    "/cache/{symbol}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Invalider le cache d'analyse pour un symbole",
)
async def invalidate_cache(
    symbol:    str,
    timeframe: Optional[str] = Query(None, description="Si None, invalide tous les TFs"),
):
    from app.data.cache_manager import CacheManager
    cache = CacheManager()
    symbol = symbol.upper()

    if timeframe:
        pattern = f"analysis:{symbol}:{timeframe}:*"
    else:
        pattern = f"analysis:{symbol}:*"

    deleted = await cache.delete_pattern(pattern)
    log.info("cache_invalidated", symbol=symbol, timeframe=timeframe, deleted=deleted)


@router.delete(
    "/cache",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Vider tout le cache d'analyse",
)
async def clear_all_cache():
    from app.data.cache_manager import CacheManager
    cache   = CacheManager()
    deleted = await cache.delete_pattern("analysis:*")
    log.info("cache_cleared_all", deleted=deleted)