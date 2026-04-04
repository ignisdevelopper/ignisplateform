"""
core/setup_scanner/setup_pipeline.py — Orchestrateur principal IGNIS (HLZ)

Ce module orchestre toute la stratégie HLZ Supply & Demand pour produire un résultat
d’analyse complet (zones S&D, structure, PA, patterns avancés, DP, SL/TP, PE, statut setup).

Caractéristiques :
- Stateless côté détecteurs (les detectors restent stateless)
- Pipeline robuste : chaque étape est isolée (try/except) + erreurs collectées
- Cache optionnel (Redis/local via CacheManager) : clé "analysis:{symbol}:{tf}:{limit}"
- API async : run_for_symbol() fetch + run_from_candles()

Utilisation :
    pipeline = SetupPipeline()
    result = await pipeline.run_for_symbol("BTCUSDT", "H4", candle_limit=500)

Pour WebSocket (cf websocket_manager.py) :
    asyncio.create_task(run_pipeline_for_symbol(symbol, timeframe, on_complete=...))
"""

from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass, field, asdict, is_dataclass
from datetime import datetime, timezone
from typing import Any, Optional, Callable, Coroutine

import structlog

from app import API_LIMITS, CACHE_CONFIG, SetupStatus

# Market structure
from app.core.market_structure import (
    PhaseDetector,
    SwingDetector,
    StructureBreaker,
)

# Base engine
from app.core.base_engine import (
    BaseDetector,
    BaseScorer,
    WeakeningBaseDetector,
    HiddenBaseDetector,
)

# SD Zones
from app.core.sd_zones import (
    SDEDetector,
    SGBDetector,
    SDPDetector,
    FlippyDetector,
    FTBDetector,
    FailedSDEDetector,
)

# PA
from app.core.pa_patterns import (
    AccuDetector,
    ThreeDrivesDetector,
    FTLDetector,
    Pattern69Detector,
    HiddenSDEDetector,
)

# Advanced
from app.core.advanced_patterns import (
    OverUnderDetector,
    IOUDetector,
    FlagLimitDetector,
    CounterAttackDetector,
    IgnoredAccuDetector,
)

# Decision points
from app.core.decision_point import (
    DPDetector,
    KeyLevelDetector,
    SLTPCalculator,
    PullbackEntryDetector,
)

log = structlog.get_logger(__name__)

OnComplete = Callable[[dict[str, Any]], Any]


# ═════════════════════════════════════════════════════════════════════════════=
# Serialization helpers
# ═════════════════════════════════════════════════════════════════════════════=

def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _dump(obj: Any) -> Any:
    """Convertit dataclass/pydantic/object -> dict sérialisable."""
    if obj is None:
        return None
    if isinstance(obj, (str, int, float, bool, list, dict)):
        return obj
    if hasattr(obj, "to_dict") and callable(getattr(obj, "to_dict")):
        try:
            return obj.to_dict()
        except Exception:
            pass
    if hasattr(obj, "model_dump") and callable(getattr(obj, "model_dump")):
        try:
            return obj.model_dump()
        except Exception:
            pass
    if is_dataclass(obj):
        try:
            return asdict(obj)
        except Exception:
            return dict(obj.__dict__)
    # fallback object
    try:
        return dict(obj.__dict__)
    except Exception:
        return str(obj)


def _best_pattern(*patterns: Any) -> dict[str, Any]:
    """
    Retourne le meilleur pattern (dict) selon champ strength (0..100) si présent.
    """
    best: Optional[dict[str, Any]] = None
    best_s = -1
    for p in patterns:
        if p is None:
            continue
        d = _dump(p)
        if not isinstance(d, dict):
            continue
        s = d.get("strength", d.get("score", 0))
        try:
            s = int(s)
        except Exception:
            s = 0
        if s > best_s and d.get("detected", d.get("created", False)) is not False:
            best_s = s
            best = d
    return best or {}


# ═════════════════════════════════════════════════════════════════════════════=
# Pipeline config/result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class SetupPipelineConfig:
    # Fetch / candles
    candle_limit: int = 500
    use_cache: bool = True
    force_refresh: bool = False

    # MTF (placeholder : l’alignement multi-tf est géré ailleurs si besoin)
    include_ltf: bool = False
    higher_tf: Optional[str] = None

    # Guards
    analysis_timeout_seconds: int = int(API_LIMITS.get("ANALYSIS_TIMEOUT_SECONDS", 30))
    max_candles_per_request: int = int(API_LIMITS.get("MAX_CANDLES_PER_REQUEST", 5000))

    # Cache keys
    cache_ttl: int = int(CACHE_CONFIG.get("ANALYSIS_TTL", 60))

    # Flags
    enable_advanced_patterns: bool = True
    enable_pa_patterns: bool = True
    enable_decision_points: bool = True
    enable_sl_tp: bool = True
    enable_pullback_entry: bool = True


@dataclass
class SetupPipelineResult:
    symbol: str
    timeframe: str
    candle_count: int
    created_at: datetime = field(default_factory=_now_utc)
    from_cache: bool = False

    # Main blocks (dicts)
    market_structure: dict[str, Any] = field(default_factory=dict)
    base: dict[str, Any] = field(default_factory=dict)
    sd_zone: dict[str, Any] = field(default_factory=dict)
    pa: dict[str, Any] = field(default_factory=dict)
    advanced: dict[str, Any] = field(default_factory=dict)
    decision_points: dict[str, Any] = field(default_factory=dict)
    sl_tp: dict[str, Any] = field(default_factory=dict)
    pullback_entry: dict[str, Any] = field(default_factory=dict)

    # Final setup output
    setup: dict[str, Any] = field(default_factory=dict)

    # Errors
    errors: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "candle_count": self.candle_count,
            "created_at": self.created_at.isoformat(),
            "from_cache": self.from_cache,
            "market_structure": self.market_structure,
            "base": self.base,
            "sd_zone": self.sd_zone,
            "pa": self.pa,
            "advanced": self.advanced,
            "decision_points": self.decision_points,
            "sl_tp": self.sl_tp,
            "pullback_entry": self.pullback_entry,
            "setup": self.setup,
            "errors": self.errors,
        }


# ═════════════════════════════════════════════════════════════════════════════=
# Pipeline
# ═════════════════════════════════════════════════════════════════════════════=

class SetupPipeline:
    """
    Orchestrateur HLZ.

    - run_from_candles() : pure orchestration (sync)
    - run_for_symbol()   : fetch + cache (async)
    """

    def __init__(self, config: Optional[SetupPipelineConfig] = None) -> None:
        self.config = config or SetupPipelineConfig()

        # Instantiate detectors once (stateless usage)
        self.phase_detector = PhaseDetector()
        self.swing_detector = SwingDetector()
        self.sb_detector = StructureBreaker()

        self.base_detector = BaseDetector()
        self.base_scorer = BaseScorer()
        self.wb_detector = WeakeningBaseDetector()
        self.hb_detector = HiddenBaseDetector()

        self.sde_detector = SDEDetector()
        self.sgb_detector = SGBDetector()
        self.sdp_detector = SDPDetector()
        self.flippy_detector = FlippyDetector()
        self.ftb_detector = FTBDetector()
        self.failed_sde = FailedSDEDetector()

        self.accu_detector = AccuDetector()
        self.three_drives_detector = ThreeDrivesDetector()
        self.ftl_detector = FTLDetector()
        self.pattern69_detector = Pattern69Detector()
        self.hidden_sde_detector = HiddenSDEDetector()

        self.ou_detector = OverUnderDetector()
        self.iou_detector = IOUDetector()
        self.flag_limit_detector = FlagLimitDetector()
        self.counter_attack_detector = CounterAttackDetector()
        self.ignored_accu_detector = IgnoredAccuDetector()

        self.key_level_detector = KeyLevelDetector()
        self.dp_detector = DPDetector()
        self.sltp = SLTPCalculator()
        self.pe_detector = PullbackEntryDetector()

    # ─────────────────────────────────────────────────────────────────────────
    # Cache
    # ─────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _cache_key(symbol: str, timeframe: str, candle_limit: int) -> str:
        return f"analysis:{symbol.upper()}:{timeframe.upper()}:{candle_limit}"

    async def _get_cache(self, key: str) -> Optional[dict[str, Any]]:
        try:
            from app.data.cache_manager import CacheManager
            cache = CacheManager()
            cached = await cache.get(key)
            if cached is None:
                return None
            if hasattr(cached, "model_dump"):
                return cached.model_dump()
            if isinstance(cached, dict):
                return cached
            return _dump(cached)
        except Exception as exc:
            log.debug("pipeline_cache_get_failed", key=key, error=str(exc))
            return None

    async def _set_cache(self, key: str, value: dict[str, Any], ttl: int) -> None:
        try:
            from app.data.cache_manager import CacheManager
            cache = CacheManager()
            await cache.set(key, value, ttl=ttl)
        except Exception as exc:
            log.debug("pipeline_cache_set_failed", key=key, error=str(exc))

    # ─────────────────────────────────────────────────────────────────────────
    # Data fetching (lazy, adaptable à tes fetchers)
    # ─────────────────────────────────────────────────────────────────────────

    async def fetch_candles(self, *, symbol: str, timeframe: str, limit: int) -> list[Any]:
        """
        Fetch candles via app.data.* (implémentation tolérante).
        Choix simple :
          - symbol finit par 'USDT' => Binance
          - sinon => Yahoo

        Adapte ici si tu as une logique asset-class dans DB/config.
        """
        symbol_u = symbol.upper().strip()
        tf_u = timeframe.upper().strip()

        if limit > self.config.max_candles_per_request:
            raise ValueError(f"limit too high ({limit}), max={self.config.max_candles_per_request}")

        # Try Binance first for crypto-like symbols
        if symbol_u.endswith("USDT") or symbol_u.endswith("USD"):
            try:
                from app.data.binance_fetcher import fetch_ohlcv as binance_fetch  # type: ignore
                candles = await binance_fetch(symbol_u, tf_u, limit=limit)  # type: ignore
                return candles
            except Exception:
                # fallback to class style
                try:
                    from app.data.binance_fetcher import BinanceFetcher  # type: ignore
                    fetcher = BinanceFetcher()
                    fn = getattr(fetcher, "fetch_ohlcv", None) or getattr(fetcher, "fetch", None)
                    if fn is None:
                        raise RuntimeError("BinanceFetcher has no fetch method")
                    res = fn(symbol_u, tf_u, limit=limit)
                    return await res if inspect.isawaitable(res) else res
                except Exception as exc:
                    log.debug("binance_fetch_failed", symbol=symbol_u, tf=tf_u, error=str(exc))

        # Yahoo fallback
        try:
            from app.data.yahoo_fetcher import fetch_ohlcv as yahoo_fetch  # type: ignore
            candles = await yahoo_fetch(symbol_u, tf_u, limit=limit)  # type: ignore
            return candles
        except Exception:
            try:
                from app.data.yahoo_fetcher import YahooFetcher  # type: ignore
                fetcher = YahooFetcher()
                fn = getattr(fetcher, "fetch_ohlcv", None) or getattr(fetcher, "fetch", None)
                if fn is None:
                    raise RuntimeError("YahooFetcher has no fetch method")
                res = fn(symbol_u, tf_u, limit=limit)
                return await res if inspect.isawaitable(res) else res
            except Exception as exc:
                raise RuntimeError(f"Unable to fetch candles for {symbol_u} {tf_u}: {exc}") from exc

    # ─────────────────────────────────────────────────────────────────────────
    # Public API
    # ─────────────────────────────────────────────────────────────────────────

    async def run_for_symbol(
        self,
        *,
        symbol: str,
        timeframe: str,
        candle_limit: Optional[int] = None,
        force_refresh: Optional[bool] = None,
    ) -> SetupPipelineResult:
        """
        Async entry : cache + fetch + run_from_candles.
        """
        cfg = self.config
        symbol_u = symbol.upper().strip()
        tf_u = timeframe.upper().strip()
        lim = int(candle_limit or cfg.candle_limit)
        fr = bool(cfg.force_refresh if force_refresh is None else force_refresh)

        cache_key = self._cache_key(symbol_u, tf_u, lim)

        if cfg.use_cache and not fr:
            cached = await self._get_cache(cache_key)
            if cached:
                try:
                    # rebuild as result
                    res = SetupPipelineResult(
                        symbol=symbol_u,
                        timeframe=tf_u,
                        candle_count=int(cached.get("candle_count", 0)),
                        from_cache=True,
                        created_at=_now_utc(),
                    )
                    # inject blocks
                    res.market_structure = cached.get("market_structure", {})
                    res.base = cached.get("base", {})
                    res.sd_zone = cached.get("sd_zone", {})
                    res.pa = cached.get("pa", {})
                    res.advanced = cached.get("advanced", {})
                    res.decision_points = cached.get("decision_points", {})
                    res.sl_tp = cached.get("sl_tp", {})
                    res.pullback_entry = cached.get("pullback_entry", {})
                    res.setup = cached.get("setup", {})
                    res.errors = cached.get("errors", [])
                    return res
                except Exception:
                    # if cache format mismatch, ignore
                    pass

        candles = await self.fetch_candles(symbol=symbol_u, timeframe=tf_u, limit=lim)

        # hard timeout guard
        try:
            res = await asyncio.wait_for(
                asyncio.to_thread(self.run_from_candles, symbol=symbol_u, timeframe=tf_u, candles=candles),
                timeout=cfg.analysis_timeout_seconds,
            )
        except asyncio.TimeoutError:
            raise TimeoutError(f"Analysis timeout after {cfg.analysis_timeout_seconds}s")
        except Exception:
            # fallback: run in event loop (some envs may not support to_thread)
            res = self.run_from_candles(symbol=symbol_u, timeframe=tf_u, candles=candles)

        if cfg.use_cache:
            await self._set_cache(cache_key, res.to_dict(), ttl=cfg.cache_ttl)

        return res

    def run_from_candles(self, *, symbol: str, timeframe: str, candles: list[Any]) -> SetupPipelineResult:
        """
        Orchestration pure (sync).
        """
        res = SetupPipelineResult(
            symbol=symbol.upper().strip(),
            timeframe=timeframe.upper().strip(),
            candle_count=len(candles),
            from_cache=False,
        )

        if not candles:
            res.errors.append({"stage": "input", "error": "empty_candles"})
            res.setup = {"status": SetupStatus.INVALID, "score": 0, "reason": "NO_DATA"}
            return res

        # ── Stage 1: Market Structure ───────────────────────────────────────
        try:
            phase = self.phase_detector.detect(candles)
            swings = self.swing_detector.detect(candles)
            sb = self.sb_detector.detect(
                candles,
                swings_high=getattr(swings, "swings_high", None),
                swings_low=getattr(swings, "swings_low", None),
            )

            res.market_structure = {
                "phase": _dump(phase),
                "swings": _dump(swings),
                "structure_break": _dump(sb),
            }
        except Exception as exc:
            res.errors.append({"stage": "market_structure", "error": str(exc)})

        # ── Stage 2: Base Engine ────────────────────────────────────────────
        base_det = None
        base_score = None
        wb = None
        hb = None

        try:
            base_det = self.base_detector.detect(candles)
            base_score = self.base_scorer.score(candles, base_det) if getattr(base_det, "detected", False) else None
            wb = self.wb_detector.detect(candles, base_det) if getattr(base_det, "detected", False) else None
            # hidden base refined later once zone exists (but we can try now too)
            hb = self.hb_detector.detect(candles, reference_zone=None, direction_hint=None)

            res.base = {
                "base_detection": _dump(base_det),
                "base_score": _dump(base_score),
                "weakening_base": _dump(wb),
                "hidden_base": _dump(hb),
            }
        except Exception as exc:
            res.errors.append({"stage": "base_engine", "error": str(exc)})

        # ── Stage 3: SDE / SGB / Zone build ─────────────────────────────────
        sde = None
        sgb = None
        zone: dict[str, Any] = {}
        flippy = None
        ftb = None
        sdp = None
        failed = None

        try:
            sde = self.sde_detector.detect(candles, base=base_det)
            sgb = self.sgb_detector.detect(candles, base=base_det)

            zone = {}
            if isinstance(_dump(sgb), dict) and _dump(sgb).get("created"):
                zone = {
                    "zone_top": _dump(sgb).get("zone_top"),
                    "zone_bot": _dump(sgb).get("zone_bot"),
                    "zone_type": _dump(sgb).get("zone_type"),
                    "proximal": _dump(sgb).get("proximal"),
                    "distal": _dump(sgb).get("distal"),
                    "base_type": _dump(sgb).get("base_type"),
                    "base_score": _dump(sgb).get("base_score"),
                    "created_index": _dump(sgb).get("created_index"),
                }

            # enrich with SDE fields if present
            if isinstance(_dump(sde), dict) and _dump(sde).get("detected"):
                zone.update({
                    "sde_detected": True,
                    "sde_score": _dump(sde).get("score"),
                    "sde_index": _dump(sde).get("sde_index"),
                    "direction": _dump(sde).get("direction"),
                    "engulf_ratio": _dump(sde).get("engulf_ratio"),
                })

            # Flippy detection (optional) — can change zone_type to FLIPPY_*
            if zone:
                flippy = self.flippy_detector.detect(candles, zone=zone)
                if _dump(flippy).get("detected"):
                    zone["is_flippy"] = True
                    zone["old_type"] = zone.get("zone_type")
                    zone["zone_type"] = _dump(flippy).get("new_zone_type") or zone.get("zone_type")

            # FTB
            if zone:
                ftb = self.ftb_detector.detect(
                    candles,
                    zone=zone,
                    creation_index=zone.get("created_index") or zone.get("sde_index"),
                    current_price=None,
                )

            # SDP
            if zone:
                sdp = self.sdp_detector.detect(
                    candles,
                    zone=zone,
                    sde=_dump(sde),
                    creation_index=zone.get("sde_index") or zone.get("created_index"),
                )
                if isinstance(_dump(sdp), dict) and _dump(sdp).get("sdp_validated"):
                    zone["sdp_validated"] = True
                    zone["head_price"] = _dump(sdp).get("head_price")

            # Failed SDE rules
            if zone:
                failed = self.failed_sde.detect(
                    candles,
                    zone=zone,
                    creation_index=zone.get("sde_index") or zone.get("created_index"),
                )

            # hidden base refinement with zone if any
            try:
                if zone:
                    hb2 = self.hb_detector.detect(candles, reference_zone=zone, direction_hint=zone.get("direction"))
                    res.base["hidden_base_refined"] = _dump(hb2)
            except Exception:
                pass

            res.sd_zone = {
                "zone": zone,
                "sde": _dump(sde),
                "sgb": _dump(sgb),
                "sdp": _dump(sdp),
                "ftb": _dump(ftb),
                "flippy": _dump(flippy),
                "failed_sde": _dump(failed),
            }

        except Exception as exc:
            res.errors.append({"stage": "sd_zones", "error": str(exc)})

        # ── Stage 4: PA Patterns ────────────────────────────────────────────
        try:
            if self.config.enable_pa_patterns and zone:
                accu = self.accu_detector.detect(candles, zone=zone)
                td = self.three_drives_detector.detect(candles, zone=zone)
                ftl = self.ftl_detector.detect(candles, zone=zone)
                hsde = self.hidden_sde_detector.detect(candles, zone=zone, flippy_hint=bool(_dump(flippy).get("detected")) if flippy else None)
                p69 = self.pattern69_detector.detect(candles, zone=zone, sde=_dump(sde), base=_dump(base_score) or _dump(base_det))

                best_pa = _best_pattern(accu, td, ftl, hsde, p69)

                res.pa = {
                    "accu": _dump(accu),
                    "three_drives": _dump(td),
                    "ftl": _dump(ftl),
                    "hidden_sde": _dump(hsde),
                    "pattern_69": _dump(p69),
                    "best": best_pa,
                }
            else:
                res.pa = {"enabled": False, "reason": "no_zone_or_disabled"}
        except Exception as exc:
            res.errors.append({"stage": "pa_patterns", "error": str(exc)})

        # ── Stage 5: Advanced Patterns ──────────────────────────────────────
        try:
            if self.config.enable_advanced_patterns and zone:
                ou = self.ou_detector.detect(candles, zone=zone)
                iou = self.iou_detector.detect(candles, zone=zone)
                fl = self.flag_limit_detector.detect(candles)
                ca = self.counter_attack_detector.detect(candles, zone=zone)
                ia = self.ignored_accu_detector.detect(candles, zone=zone)

                best_adv = _best_pattern(ou, iou, fl, ca, ia)

                res.advanced = {
                    "over_under": _dump(ou),
                    "iou": _dump(iou),
                    "flag_limit": _dump(fl),
                    "counter_attack": _dump(ca),
                    "ignored_accu": _dump(ia),
                    "best": best_adv,
                }
            else:
                res.advanced = {"enabled": False, "reason": "no_zone_or_disabled"}
        except Exception as exc:
            res.errors.append({"stage": "advanced_patterns", "error": str(exc)})

        # ── Stage 6: Decision Points + Key Levels ───────────────────────────
        key_levels = []
        best_dp = {}
        dps = []
        try:
            if self.config.enable_decision_points:
                key_levels = self.key_level_detector.detect(candles)
                ms = res.market_structure.get("structure_break", {})
                ms_level = (ms.get("broken_level") if isinstance(ms, dict) else None) or (ms.get("broken_level") if isinstance(ms, dict) else None)

                market_structure_ctx = {
                    "sb_level": ms.get("broken_level") if isinstance(ms, dict) else None,
                    "direction": ms.get("direction") if isinstance(ms, dict) else None,
                }

                # zones list for dp detector (include enriched zone dict + sdp if any)
                zones_for_dp = [zone] if zone else []

                dp_list = self.dp_detector.detect_all(
                    candles,
                    zones=zones_for_dp,
                    key_levels=[_dump(x) for x in key_levels] if key_levels else None,
                    market_structure=market_structure_ctx,
                    current_price=None,
                )

                dps = [_dump(x) for x in dp_list]
                best_dp = dps[0] if dps else {}

                res.decision_points = {
                    "key_levels": [_dump(k) for k in key_levels],
                    "dps": dps,
                    "best_dp": best_dp,
                }
            else:
                res.decision_points = {"enabled": False}
        except Exception as exc:
            res.errors.append({"stage": "decision_points", "error": str(exc)})

        # ── Stage 7: SL/TP + Pullback Entry ─────────────────────────────────
        try:
            if self.config.enable_sl_tp and zone:
                sltp_res = self.sltp.calculate(
                    candles,
                    zone=zone,
                    key_levels=[_dump(k) for k in key_levels] if key_levels else None,
                    dp=best_dp or None,
                    current_price=None,
                )
                res.sl_tp = _dump(sltp_res)
            else:
                res.sl_tp = {"enabled": False, "reason": "no_zone_or_disabled"}
        except Exception as exc:
            res.errors.append({"stage": "sl_tp", "error": str(exc)})

        try:
            if self.config.enable_pullback_entry and zone:
                pe = self.pe_detector.detect(
                    candles,
                    zone=zone,
                    dp=best_dp or None,
                    current_price=None,
                    direction_hint=(res.sl_tp.get("direction") if isinstance(res.sl_tp, dict) else None),
                )
                res.pullback_entry = _dump(pe)
            else:
                res.pullback_entry = {"enabled": False, "reason": "no_zone_or_disabled"}
        except Exception as exc:
            res.errors.append({"stage": "pullback_entry", "error": str(exc)})

        # ── Stage 8: Setup status + score (fallback simple si Validator/Scorer absents) ──
        try:
            res.setup = self._finalize_setup(res)
        except Exception as exc:
            res.errors.append({"stage": "setup_finalize", "error": str(exc)})
            res.setup = {"status": SetupStatus.WATCH, "score": 0, "reason": "FINALIZE_ERROR"}

        return res

    # ─────────────────────────────────────────────────────────────────────────
    # Setup finalize (fallback)
    # ─────────────────────────────────────────────────────────────────────────

    def _finalize_setup(self, res: SetupPipelineResult) -> dict[str, Any]:
        """
        Si app.core.setup_scanner.setup_validator/setup_scorer existent, on les utilise.
        Sinon, fallback HLZ simple.
        """
        # Try external validator/scorer if present
        try:
            from app.core.setup_scanner.setup_validator import SetupValidator  # type: ignore
            from app.core.setup_scanner.setup_scorer import SetupScorer  # type: ignore

            validator = SetupValidator()
            scorer = SetupScorer()

            # conventions attendues (tu pourras adapter quand tu coderas Validator/Scorer)
            validation = validator.validate(res.to_dict())  # type: ignore
            scoring = scorer.score(res.to_dict())          # type: ignore

            v = _dump(validation)
            s = _dump(scoring)
            return {
                "status": v.get("status", SetupStatus.WATCH),
                "checklist": v.get("checklist", {}),
                "reason": v.get("reason", ""),
                "score": s.get("score", 0),
                "breakdown": s.get("breakdown", {}),
            }
        except Exception:
            pass

        # ── Fallback simple ────────────────────────────────────────────────
        base_score = (((res.base.get("base_score") or {}) if isinstance(res.base, dict) else {}) or {}).get("score", 0)
        sde = (res.sd_zone.get("sde") or {}) if isinstance(res.sd_zone, dict) else {}
        sgb = (res.sd_zone.get("sgb") or {}) if isinstance(res.sd_zone, dict) else {}
        sdp = (res.sd_zone.get("sdp") or {}) if isinstance(res.sd_zone, dict) else {}
        ftb = (res.sd_zone.get("ftb") or {}) if isinstance(res.sd_zone, dict) else {}
        flippy = (res.sd_zone.get("flippy") or {}) if isinstance(res.sd_zone, dict) else {}
        failed = (res.sd_zone.get("failed_sde") or {}) if isinstance(res.sd_zone, dict) else {}

        pa_best = (res.pa.get("best") or {}) if isinstance(res.pa, dict) else {}
        adv_best = (res.advanced.get("best") or {}) if isinstance(res.advanced, dict) else {}
        sltp = res.sl_tp if isinstance(res.sl_tp, dict) else {}

        checklist = {
            "Base solide": int(base_score or 0) >= 70,
            "SDE détecté": bool(sde.get("detected")),
            "SGB créé": bool(sgb.get("created")),
            "SDP validé": bool(sdp.get("sdp_validated")) or (sdp.get("status") == "VALIDATED"),
            "Pas FLIPPY": not bool(flippy.get("detected")),
            "SDE non failed": not bool(failed.get("failed")),
            "FTB disponible": bool(ftb.get("ftb_valid", False)),  # True si 0 touches
            "RR OK": bool(sltp.get("rr_ok", False)) if sltp else False,
        }

        # Score simple : moyenne pondérée
        sde_score = int(sde.get("score", 0) or 0)
        sdp_strength = int(sdp.get("strength", 0) or 0)
        pa_strength = int(pa_best.get("strength", 0) or 0)
        adv_strength = int(adv_best.get("strength", 0) or 0)
        rr_bonus = 10 if sltp.get("rr_ok") else 0
        flippy_penalty = 40 if flippy.get("detected") else 0
        failed_penalty = 35 if failed.get("failed") else 0
        ftb_penalty = 20 if not ftb.get("ftb_valid", False) else 0

        score = int(round(
            0.30 * (base_score or 0)
            + 0.20 * sde_score
            + 0.15 * sdp_strength
            + 0.15 * pa_strength
            + 0.10 * adv_strength
            + rr_bonus
            - flippy_penalty
            - failed_penalty
            - ftb_penalty
        ))
        score = max(0, min(100, score))

        # Status logic
        if not sgb.get("created") and sde.get("detected"):
            status = SetupStatus.PENDING
            reason = "SDE trouvé, SGB en attente."
        elif flippy.get("detected"):
            status = SetupStatus.INVALID
            reason = "Zone FLIPPY détectée."
        elif failed.get("failed"):
            status = SetupStatus.INVALID
            reason = f"Failed SDE: {failed.get('reason', 'FAILED')}"
        elif all(checklist.values()) and score >= 75:
            status = SetupStatus.VALID
            reason = "Setup complet aligné."
        elif sde.get("detected") or sgb.get("created"):
            status = SetupStatus.WATCH
            reason = "Zone détectée, surveillance."
        else:
            status = SetupStatus.WATCH
            reason = "Aucun setup clair."

        return {
            "status": status,
            "score": score,
            "reason": reason,
            "checklist": checklist,
            "signals": {
                "pa_best": pa_best,
                "advanced_best": adv_best,
            },
        }


# ═════════════════════════════════════════════════════════════════════════════=
# Helper function used by websocket_manager.py
# ═════════════════════════════════════════════════════════════════════════════=

async def run_pipeline_for_symbol(
    *,
    symbol: str,
    timeframe: str,
    candle_limit: int = 500,
    higher_tf: Optional[str] = None,
    include_ltf: bool = False,
    force_refresh: bool = False,
    on_complete: Optional[OnComplete] = None,
) -> dict[str, Any]:
    """
    Helper global : exécute le pipeline et appelle on_complete(result_dict) si fourni.
    Compatible avec websocket_manager.py (callback peut retourner une coroutine).
    """
    pipeline = SetupPipeline(SetupPipelineConfig(
        candle_limit=candle_limit,
        include_ltf=include_ltf,
        higher_tf=higher_tf,
        force_refresh=force_refresh,
    ))

    result = await pipeline.run_for_symbol(
        symbol=symbol,
        timeframe=timeframe,
        candle_limit=candle_limit,
        force_refresh=force_refresh,
    )
    payload = result.to_dict()

    if on_complete is not None:
        try:
            r = on_complete(payload)
            if inspect.isawaitable(r):
                await r
        except Exception as exc:
            log.warning("pipeline_on_complete_failed", symbol=symbol, timeframe=timeframe, error=str(exc))

    return payload
