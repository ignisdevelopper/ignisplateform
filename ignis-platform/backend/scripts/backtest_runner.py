```python
"""
backtestrunner.py — Backtest Runner IGNIS (HLZ)

But :
- Exécuter un backtest "event-driven" simple sur la stratégie HLZ (Supply & Demand)
  en réutilisant le SetupPipeline (zones, PA, advanced, DP, SL/TP, PE).
- Produire des trades simulés + métriques (winrate, PF, expectancy, drawdown, etc.)

⚠️ Ce backtester est volontairement générique et conservateur :
- Pas d’optimisation microstructure (spread réel, latence, partial fills).
- SL/TP : si SL et TP touchés dans la même bougie, règle configurable (worst/best).
- Une position à la fois par défaut (configurable).

Entrées :
- candles fournis (list[dict/obj]) OU fetch via Binance/Yahoo (via SetupPipeline.fetch_candles)

Sorties :
- BacktestResult avec trades + equity curve + metrics.

Dépendances :
- app.core.setup_scanner.setup_pipeline.SetupPipeline
- app.data.data_normalizer.DataNormalizer (optionnel si tes fetchers renvoient déjà le format)
"""

from __future__ import annotations

import asyncio
import math
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional, Literal

import structlog

from app import SetupStatus
from app.core.setup_scanner.setup_pipeline import SetupPipeline, SetupPipelineConfig
from app.data.data_normalizer import DataNormalizer

log = structlog.get_logger(__name__)

Side = Literal["LONG", "SHORT"]
FillPolicy = Literal["WORST_CASE", "BEST_CASE", "SL_FIRST", "TP_FIRST"]
EntryTrigger = Literal["PE_READY", "SETUP_VALID"]


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers (tolérant candle dict/obj)
# ═════════════════════════════════════════════════════════════════════════════=

def _c_get(c: Any, key: str, default: Any = 0.0) -> Any:
    if isinstance(c, dict):
        return c.get(key, default)
    return getattr(c, key, default)


def _f(x: Any, default: float = 0.0) -> float:
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except Exception:
        return default


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _open_time_ms(c: Any) -> Optional[int]:
    for k in ("open_time", "openTime", "timestamp", "time", "t", "ts"):
        v = _c_get(c, k, None)
        if v is None:
            continue
        # datetime
        if hasattr(v, "timestamp"):
            try:
                return int(v.timestamp() * 1000)
            except Exception:
                continue
        try:
            vv = float(v)
            # seconds vs ms heuristic
            return int(vv * 1000) if vv < 10_000_000_000 else int(vv)
        except Exception:
            continue
    return None


def _side_from_direction(direction: str) -> Side:
    d = (direction or "").upper()
    return "LONG" if d == "BULLISH" else "SHORT"


def _apply_slippage(price: float, side: Side, slippage_bps: float) -> float:
    """
    slippage_bps : basis points (1bp=0.01%)
    Long entry: price * (1 + slip)
    Short entry: price * (1 - slip)
    """
    slip = (slippage_bps / 10_000.0)
    if side == "LONG":
        return price * (1.0 + slip)
    return price * (1.0 - slip)


def _fee_amount(notional: float, fee_bps: float) -> float:
    return abs(notional) * (fee_bps / 10_000.0)


def _rr(entry: float, sl: float, tp: float) -> float:
    risk = abs(entry - sl)
    if risk <= 0:
        return 0.0
    reward = abs(tp - entry)
    return reward / risk


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class BacktestConfig:
    symbol: str
    timeframe: str

    # Candles
    candle_limit: int = 8000
    warmup_bars: int = 400                # nb bougies avant de commencer à générer des signaux
    analysis_window: int = 600            # nb bougies max passées au pipeline à chaque pas

    # Trading logic
    entry_trigger: EntryTrigger = "PE_READY"
    allow_entry_inside_zone: bool = True  # si entry est déjà "touchée" à la bougie signal

    one_position_at_a_time: bool = True

    # Execution
    fill_policy: FillPolicy = "WORST_CASE"  # si SL et TP touchés same candle
    enter_on_next_open: bool = True         # sinon entrée "au close" de la bougie signal

    # Costs
    fee_bps: float = 2.0                   # 0.02%
    slippage_bps: float = 1.0              # 0.01%

    # Risk
    starting_equity: float = 10_000.0
    risk_per_trade_pct: float = 1.0        # % equity risqué par trade (position sizing)

    # Filters
    min_setup_score: int = 75
    require_rr_ok: bool = True
    min_rr: float = 2.0

    # Performance / safety
    max_trades: int = 10_000
    log_every: int = 0                     # 0 = off


@dataclass
class BacktestTrade:
    trade_id: str
    symbol: str
    timeframe: str

    side: Side
    entry_index: int
    exit_index: int

    entry_time_ms: Optional[int]
    exit_time_ms: Optional[int]

    entry: float
    sl: float
    tp: float
    rr_planned: float

    size: float                 # quantity (units)
    risk_amount: float          # currency
    fees_paid: float

    exit_price: float
    exit_reason: str            # "TP" | "SL" | "EOD" | "INVALID"
    pnl: float                  # currency
    pnl_pct: float              # pnl / equity_at_entry

    mae: Optional[float] = None # max adverse excursion (currency)
    mfe: Optional[float] = None # max favorable excursion (currency)

    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class EquityPoint:
    index: int
    time_ms: Optional[int]
    equity: float
    drawdown_pct: float = 0.0


@dataclass
class BacktestMetrics:
    trades: int = 0
    wins: int = 0
    losses: int = 0
    winrate_pct: float = 0.0

    gross_profit: float = 0.0
    gross_loss: float = 0.0
    profit_factor: float = 0.0

    expectancy: float = 0.0
    avg_win: float = 0.0
    avg_loss: float = 0.0

    max_drawdown_pct: float = 0.0
    final_equity: float = 0.0
    return_pct: float = 0.0


@dataclass
class BacktestResult:
    config: BacktestConfig
    started_at: datetime = field(default_factory=_now_utc)
    finished_at: Optional[datetime] = None
    duration_ms: int = 0

    candle_count: int = 0
    trades: list[BacktestTrade] = field(default_factory=list)
    equity_curve: list[EquityPoint] = field(default_factory=list)
    metrics: BacktestMetrics = field(default_factory=BacktestMetrics)

    errors: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "config": self.config.__dict__,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "duration_ms": self.duration_ms,
            "candle_count": self.candle_count,
            "trades": [t.__dict__ for t in self.trades],
            "equity_curve": [e.__dict__ for e in self.equity_curve],
            "metrics": self.metrics.__dict__,
            "errors": self.errors,
        }


# ═════════════════════════════════════════════════════════════════════════════=
# Runner
# ═════════════════════════════════════════════════════════════════════════════=

class BacktestRunner:
    """
    Runner principal.

    - run_from_candles(): backtest sur candles déjà chargées
    - run_for_symbol(): fetch + normalize + run
    """

    def __init__(self, *, pipeline: Optional[SetupPipeline] = None) -> None:
        self.pipeline = pipeline or SetupPipeline(SetupPipelineConfig())

    async def run_for_symbol(self, config: BacktestConfig) -> BacktestResult:
        """
        Fetch via pipeline.fetch_candles() puis run_from_candles().
        """
        candles = await self.pipeline.fetch_candles(
            symbol=config.symbol,
            timeframe=config.timeframe,
            limit=config.candle_limit,
        )
        # normalize defensively
        candles = DataNormalizer.normalize(
            candles,
            symbol=config.symbol,
            timeframe=config.timeframe,
            source=(candles[0].get("source") if candles and isinstance(candles[0], dict) else "unknown"),
            strict_sort=True,
        )
        return await self.run_from_candles(config=config, candles=candles)

    async def run_from_candles(self, *, config: BacktestConfig, candles: list[Any]) -> BacktestResult:
        """
        Backtest async (orchestration), mais le pipeline est sync => on l’appelle en to_thread.
        """
        t0 = time.time()
        res = BacktestResult(config=config, candle_count=len(candles))

        if not candles or len(candles) < config.warmup_bars + 50:
            res.errors.append({"stage": "input", "error": "not_enough_candles"})
            res.finished_at = _now_utc()
            res.duration_ms = int((time.time() - t0) * 1000)
            return res

        equity = float(config.starting_equity)
        peak = equity
        max_dd = 0.0

        open_trade: Optional[BacktestTrade] = None
        equity_at_entry = equity

        # store points at each bar (optional but useful)
        def push_equity_point(i: int) -> None:
            nonlocal peak, max_dd
            if equity > peak:
                peak = equity
            dd = 0.0 if peak <= 0 else (peak - equity) / peak
            max_dd = max(max_dd, dd)
            res.equity_curve.append(EquityPoint(
                index=i,
                time_ms=_open_time_ms(candles[i]),
                equity=equity,
                drawdown_pct=round(dd * 100, 4),
            ))

        push_equity_point(config.warmup_bars)

        # ── Iterate candles ────────────────────────────────────────────────
        for i in range(config.warmup_bars, len(candles) - 1):
            if len(res.trades) >= config.max_trades:
                break

            # 1) If there is an open trade, check exit on current candle
            if open_trade is not None:
                exit_info = _check_exit_on_candle(
                    candle=candles[i],
                    side=open_trade.side,
                    sl=open_trade.sl,
                    tp=open_trade.tp,
                    fill_policy=config.fill_policy,
                )
                if exit_info is not None:
                    exit_price, reason = exit_info

                    # apply slippage on exit too (conservative)
                    exit_price = _apply_slippage(exit_price, "SHORT" if open_trade.side == "LONG" else "LONG", config.slippage_bps)

                    pnl = _compute_pnl(open_trade.side, open_trade.entry, exit_price, open_trade.size)
                    notional_entry = open_trade.entry * open_trade.size
                    notional_exit = exit_price * open_trade.size
                    fees = _fee_amount(notional_entry, config.fee_bps) + _fee_amount(notional_exit, config.fee_bps)

                    pnl_net = pnl - fees
                    equity = equity + pnl_net

                    open_trade.exit_index = i
                    open_trade.exit_time_ms = _open_time_ms(candles[i])
                    open_trade.exit_price = exit_price
                    open_trade.exit_reason = reason
                    open_trade.fees_paid += fees
                    open_trade.pnl = pnl_net
                    open_trade.pnl_pct = (pnl_net / equity_at_entry * 100.0) if equity_at_entry > 0 else 0.0

                    res.trades.append(open_trade)
                    open_trade = None

                    push_equity_point(i)
                    continue

                # still open
                if (config.log_every and i % config.log_every == 0):
                    log.info("backtest_progress", i=i, equity=equity, open_trade=True)
                continue

            # 2) No open trade => compute analysis at i (using window)
            start = max(0, i + 1 - config.analysis_window)
            window = candles[start : i + 1]

            try:
                analysis = await asyncio.to_thread(
                    self.pipeline.run_from_candles,
                    symbol=config.symbol,
                    timeframe=config.timeframe,
                    candles=window,
                )
                a = analysis.to_dict() if hasattr(analysis, "to_dict") else analysis  # type: ignore
            except Exception as exc:
                res.errors.append({"stage": "pipeline", "index": i, "error": str(exc)})
                continue

            setup = (a.get("setup") or {})
            setup_status = str(setup.get("status") or "").upper()
            setup_score = int(setup.get("score") or 0)

            if setup_score < config.min_setup_score:
                continue

            if setup_status != SetupStatus.VALID and config.entry_trigger == "SETUP_VALID":
                continue

            # PE_READY trigger
            pe = (a.get("pullback_entry") or {})
            pe_state = str(pe.get("state") or "").upper()
            pe_detected = bool(pe.get("detected", False))
            if config.entry_trigger == "PE_READY":
                if not (pe_detected and pe_state == "READY"):
                    continue

            # SL/TP required
            sltp = (a.get("sl_tp") or {})
            if not sltp or not sltp.get("valid", True) and ("entry" not in sltp):
                continue

            entry = sltp.get("entry")
            sl = sltp.get("stop_loss") or sltp.get("sl")
            tp = sltp.get("take_profit") or sltp.get("tp")
            rr = sltp.get("rr")

            if entry is None or sl is None or tp is None:
                continue

            entry = float(entry)
            sl = float(sl)
            tp = float(tp)
            rr_planned = float(rr) if rr is not None else _rr(entry, sl, tp)

            if config.require_rr_ok:
                rr_ok = bool(sltp.get("rr_ok", False))
                if not rr_ok and rr_planned < config.min_rr:
                    continue

            direction = str(sltp.get("direction") or sltp.get("side") or "").upper()
            if direction not in ("BULLISH", "BEARISH"):
                # infer from entry/sl/tp geometry
                direction = "BULLISH" if tp > entry else "BEARISH"

            side: Side = _side_from_direction(direction)

            # Ensure SL/TP are consistent with side
            if side == "LONG":
                if not (sl < entry < tp):
                    continue
            else:
                if not (tp < entry < sl):
                    continue

            # Entry fill:
            # - default: next candle open
            entry_index = i + 1 if config.enter_on_next_open else i
            if entry_index >= len(candles):
                break

            entry_fill_price = _f(_c_get(candles[entry_index], "open"), default=_f(_c_get(candles[entry_index], "close")))
            # If allow_entry_inside_zone and price crosses entry in signal candle, we can fill at entry (limit-style)
            if not config.enter_on_next_open and config.allow_entry_inside_zone:
                # if current candle range crosses entry, fill at entry
                hi = _f(_c_get(candles[i], "high"))
                lo = _f(_c_get(candles[i], "low"))
                if lo <= entry <= hi:
                    entry_fill_price = entry

            entry_fill_price = _apply_slippage(entry_fill_price, side, config.slippage_bps)

            # Position sizing
            risk_amount = equity * (config.risk_per_trade_pct / 100.0)
            risk_per_unit = abs(entry_fill_price - sl)
            if risk_per_unit <= 0:
                continue

            size = risk_amount / risk_per_unit

            # Fees at entry (deduct now or at close? we store in trade and apply at exit)
            fees_entry = _fee_amount(entry_fill_price * size, config.fee_bps)

            # Create trade (open)
            equity_at_entry = equity
            open_trade = BacktestTrade(
                trade_id=f"T{len(res.trades) + 1:06d}",
                symbol=config.symbol.upper(),
                timeframe=config.timeframe.upper(),
                side=side,
                entry_index=entry_index,
                exit_index=entry_index,  # placeholder
                entry_time_ms=_open_time_ms(candles[entry_index]),
                exit_time_ms=None,
                entry=float(entry_fill_price),
                sl=float(sl),
                tp=float(tp),
                rr_planned=float(rr_planned),
                size=float(size),
                risk_amount=float(risk_amount),
                fees_paid=float(fees_entry),
                exit_price=float(entry_fill_price),
                exit_reason="OPEN",
                pnl=0.0,
                pnl_pct=0.0,
                meta={
                    "signal_index": i,
                    "setup_score": setup_score,
                    "setup_status": setup_status,
                    "pa_best": (a.get("pa") or {}).get("best"),
                    "adv_best": (a.get("advanced") or {}).get("best"),
                    "best_dp": (a.get("decision_points") or {}).get("best_dp"),
                    "pe": pe,
                },
            )

            # Immediate exit check on same entry candle (rare but possible)
            # We will check from entry_index candle on next loop; but if entry_index==i, check now.
            if entry_index == i:
                exit_info = _check_exit_on_candle(
                    candle=candles[i],
                    side=open_trade.side,
                    sl=open_trade.sl,
                    tp=open_trade.tp,
                    fill_policy=config.fill_policy,
                )
                if exit_info is not None:
                    # handle on next iteration naturally, but we can finalize now
                    pass

            if (config.log_every and i % config.log_every == 0):
                log.info("backtest_entry", i=i, entry_index=entry_index, side=side, equity=equity)

        # Close open trade at EOD
        if open_trade is not None:
            last_idx = len(candles) - 1
            exit_price = _f(_c_get(candles[last_idx], "close"))
            exit_price = _apply_slippage(exit_price, "SHORT" if open_trade.side == "LONG" else "LONG", config.slippage_bps)

            pnl = _compute_pnl(open_trade.side, open_trade.entry, exit_price, open_trade.size)
            fees = _fee_amount(open_trade.entry * open_trade.size, config.fee_bps) + _fee_amount(exit_price * open_trade.size, config.fee_bps)

            pnl_net = pnl - fees
            equity = equity + pnl_net

            open_trade.exit_index = last_idx
            open_trade.exit_time_ms = _open_time_ms(candles[last_idx])
            open_trade.exit_price = exit_price
            open_trade.exit_reason = "EOD"
            open_trade.fees_paid += fees
            open_trade.pnl = pnl_net
            open_trade.pnl_pct = (pnl_net / equity_at_entry * 100.0) if equity_at_entry > 0 else 0.0

            res.trades.append(open_trade)
            open_trade = None

            push_equity_point(last_idx)

        # ── Metrics ─────────────────────────────────────────────────────────
        res.metrics = _compute_metrics(res.trades, config.starting_equity, equity, max_dd)

        res.finished_at = _now_utc()
        res.duration_ms = int((time.time() - t0) * 1000)
        return res


# ═════════════════════════════════════════════════════════════════════════════=
# Exit & PnL internals
# ═════════════════════════════════════════════════════════════════════════════=

def _compute_pnl(side: Side, entry: float, exit_price: float, size: float) -> float:
    if side == "LONG":
        return (exit_price - entry) * size
    return (entry - exit_price) * size


def _check_exit_on_candle(
    *,
    candle: Any,
    side: Side,
    sl: float,
    tp: float,
    fill_policy: FillPolicy,
) -> Optional[tuple[float, str]]:
    """
    Retourne (exit_price, reason) ou None.
    Hypothèse: OHLC de la bougie connue.
    """
    hi = _f(_c_get(candle, "high"))
    lo = _f(_c_get(candle, "low"))

    if hi <= 0 and lo <= 0:
        return None

    if side == "LONG":
        sl_hit = lo <= sl
        tp_hit = hi >= tp
        if not (sl_hit or tp_hit):
            return None

        if sl_hit and tp_hit:
            # ambiguity
            if fill_policy in ("WORST_CASE", "SL_FIRST"):
                return sl, "SL"
            if fill_policy in ("BEST_CASE", "TP_FIRST"):
                return tp, "TP"
            return sl, "SL"

        return (tp, "TP") if tp_hit else (sl, "SL")

    # SHORT
    sl_hit = hi >= sl
    tp_hit = lo <= tp
    if not (sl_hit or tp_hit):
        return None

    if sl_hit and tp_hit:
        if fill_policy in ("WORST_CASE", "SL_FIRST"):
            return sl, "SL"
        if fill_policy in ("BEST_CASE", "TP_FIRST"):
            return tp, "TP"
        return sl, "SL"

    return (tp, "TP") if tp_hit else (sl, "SL")


def _compute_metrics(trades: list[BacktestTrade], start_equity: float, final_equity: float, max_dd01: float) -> BacktestMetrics:
    m = BacktestMetrics()
    m.trades = len(trades)

    if not trades:
        m.final_equity = final_equity
        m.return_pct = 0.0 if start_equity <= 0 else (final_equity - start_equity) / start_equity * 100.0
        m.max_drawdown_pct = round(max_dd01 * 100.0, 4)
        return m

    wins = [t for t in trades if t.pnl > 0]
    losses = [t for t in trades if t.pnl < 0]

    m.wins = len(wins)
    m.losses = len(losses)
    m.winrate_pct = round((m.wins / m.trades) * 100.0, 4) if m.trades else 0.0

    m.gross_profit = round(sum(t.pnl for t in wins), 8)
    m.gross_loss = round(abs(sum(t.pnl for t in losses)), 8)

    m.profit_factor = round(m.gross_profit / m.gross_loss, 6) if m.gross_loss > 0 else float("inf")

    m.avg_win = round((m.gross_profit / m.wins), 8) if m.wins else 0.0
    m.avg_loss = round((m.gross_loss / m.losses), 8) if m.losses else 0.0

    # expectancy per trade
    m.expectancy = round((sum(t.pnl for t in trades) / m.trades), 8) if m.trades else 0.0

    m.max_drawdown_pct = round(max_dd01 * 100.0, 4)
    m.final_equity = round(final_equity, 8)
    m.return_pct = 0.0 if start_equity <= 0 else round((final_equity - start_equity) / start_equity * 100.0, 6)

    return m


# ═════════════════════════════════════════════════════════════════════════════=
# Helper async
# ═════════════════════════════════════════════════════════════════════════════=

async def run_backtest_for_symbol(config: BacktestConfig) -> BacktestResult:
    """
    Shortcut :
        res = await run_backtest_for_symbol(BacktestConfig(symbol="BTCUSDT", timeframe="H4"))
    """
    runner = BacktestRunner()
    return await runner.run_for_symbol(config)
```