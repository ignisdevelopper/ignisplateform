"""
data/yahoo_fetcher.py — Yahoo Finance OHLCV Fetcher (IGNIS)

Fetch OHLCV via yfinance (actions / forex / indices / commodities).
- Async (wrapping yfinance sync calls via asyncio.to_thread)
- Supporte les timeframes IGNIS (M1..MN1) via :
  • mapping direct interval Yahoo quand possible
  • fallback resampling (ex: H2/H4/H8 depuis 60m)

Sortie normalisée (dict Candle-like) :
{
  "open_time":  int (ms) | None,
  "close_time": int (ms) | None,
  "open": float, "high": float, "low": float, "close": float,
  "volume": float,
  "symbol": str,
  "timeframe": str,
  "source": "yahoo",
}

Notes Yahoo/yfinance :
- Les intervalles intraday ont des limites d'historique (ex: 1m ≈ 7 jours).
- Certains symboles forex nécessitent le suffixe "=X" (ex: "EURUSD=X").
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

import structlog

from app import TIMEFRAMES, API_LIMITS
from app.data.data_normalizer import DataNormalizer

log = structlog.get_logger(__name__)

# yfinance import lazy (évite crash si non installé au moment de l'import)
try:  # pragma: no cover
    import yfinance as yf  # type: ignore
except Exception:  # pragma: no cover
    yf = None  # type: ignore


def _tf_minutes(tf: str) -> int:
    tfu = (tf or "").upper().strip()
    if tfu not in TIMEFRAMES:
        raise ValueError(f"Unsupported timeframe: {tf}")
    return int(TIMEFRAMES[tfu])


def _is_forex_like(symbol: str) -> bool:
    s = symbol.upper().strip()
    return len(s) == 6 and s.isalpha()


def _normalize_symbol(symbol: str) -> str:
    s = (symbol or "").upper().strip()
    # Heuristique simple FX : "EURUSD" => "EURUSD=X"
    if _is_forex_like(s) and not s.endswith("=X"):
        return f"{s}=X"
    return s


def _yahoo_interval_for_tf(tf: str) -> tuple[str, Optional[str]]:
    """
    Retourne (interval, resample_from_interval)
    - si interval direct supporté : resample_from_interval=None
    - si non supporté : retourne interval base + indique resample depuis base
    """
    tfu = tf.upper().strip()

    direct = {
        "M1": "1m",
        "M5": "5m",
        "M15": "15m",
        "M30": "30m",
        "H1": "60m",   # yfinance accepte 60m
        "D1": "1d",
        "W1": "1wk",
        "MN1": "1mo",
    }
    if tfu in direct:
        return direct[tfu], None

    # TF non directement supportés -> resample depuis "60m"
    if tfu in ("H2", "H4", "H8"):
        return "60m", "60m"

    # fallback : essayer 1d
    return "1d", None


def _period_for_request(tf: str, limit: int) -> str:
    """
    Choisit un 'period' yfinance (string) en fonction du timeframe et du nombre de bougies désirées.
    C'est une heuristique (yfinance a des limites par interval).
    """
    tfu = tf.upper().strip()

    # Intraday hard limits (approx yfinance):
    # - 1m: ~7d
    # - 2m/5m/15m/30m/60m/90m: ~60d
    if tfu == "M1":
        return "7d"

    if tfu in ("M5", "M15", "M30", "H1", "H2", "H4", "H8"):
        # estimer jours nécessaires
        minutes = _tf_minutes(tfu)
        approx_days = max(1, int(math.ceil((limit * minutes) / (60 * 24))))
        # clamp to yfinance intraday typical max 60d
        return f"{min(max(approx_days, 5), 60)}d"

    # Daily/weekly/monthly => on peut demander plus
    if tfu == "D1":
        approx_days = max(30, int(limit * 1.5))
        # yfinance supports up to "max"
        return f"{min(approx_days, 730)}d"  # 2 ans max en daily par défaut ici
    if tfu == "W1":
        approx_weeks = max(52, int(limit * 1.2))
        approx_days = approx_weeks * 7
        return f"{min(approx_days, 3650)}d"  # 10 ans cap
    if tfu == "MN1":
        return "max"

    return "max"


def _to_ms(dt: Any) -> Optional[int]:
    if dt is None:
        return None
    if isinstance(dt, (int, float)):
        # seconds vs ms
        if dt < 10_000_000_000:
            return int(dt * 1000)
        return int(dt)
    if hasattr(dt, "to_pydatetime"):
        try:
            dt = dt.to_pydatetime()
        except Exception:
            pass
    if hasattr(dt, "timestamp"):
        try:
            # ensure UTC
            if getattr(dt, "tzinfo", None) is None:
                dt = dt.replace(tzinfo=timezone.utc)
            else:
                dt = dt.astimezone(timezone.utc)
            return int(dt.timestamp() * 1000)
        except Exception:
            return None
    return None


def _resample_candles(candles: list[dict[str, Any]], *, target_tf: str) -> list[dict[str, Any]]:
    """
    Resample une série (supposée régulière) vers un timeframe plus haut.
    Grouping par bucket de temps sur open_time.
    """
    if not candles:
        return []

    target_minutes = _tf_minutes(target_tf)
    bucket_ms = target_minutes * 60_000

    # Filtrer celles sans open_time
    c2 = [c for c in candles if isinstance(c.get("open_time"), int)]
    if not c2:
        return candles

    c2.sort(key=lambda x: x["open_time"])  # type: ignore

    groups: dict[int, list[dict[str, Any]]] = {}
    for c in c2:
        ot = int(c["open_time"])
        bucket = ot // bucket_ms
        groups.setdefault(bucket, []).append(c)

    out: list[dict[str, Any]] = []
    for bucket in sorted(groups.keys()):
        g = groups[bucket]
        g.sort(key=lambda x: x["open_time"])  # type: ignore

        open_time = int(g[0]["open_time"])
        close_time = int(open_time + bucket_ms - 1)

        o = float(g[0]["open"])
        h = max(float(x["high"]) for x in g)
        l = min(float(x["low"]) for x in g)
        cl = float(g[-1]["close"])
        v = float(sum(float(x.get("volume", 0.0) or 0.0) for x in g))

        base = dict(g[0])
        base.update({
            "open_time": open_time,
            "close_time": close_time,
            "open": o,
            "high": h,
            "low": l,
            "close": cl,
            "volume": v,
            "timeframe": target_tf.upper(),
            "source": "yahoo",
        })
        out.append(base)

    return out


@dataclass(frozen=True)
class YahooFetcherConfig:
    max_total_limit: int = int(API_LIMITS.get("MAX_CANDLES_PER_REQUEST", 5000))
    auto_adjust: bool = False
    prepost: bool = False


class YahooFetcher:
    """
    Fetcher Yahoo via yfinance.

    Usage:
        f = YahooFetcher()
        candles = await f.fetch_ohlcv("AAPL", "H4", limit=500)
        candles = await f.fetch_ohlcv("EURUSD", "H1", limit=300)  # -> "EURUSD=X"
    """

    def __init__(self, config: Optional[YahooFetcherConfig] = None) -> None:
        self.config = config or YahooFetcherConfig()

    async def fetch_ohlcv(
        self,
        symbol: str,
        timeframe: str,
        *,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        if yf is None:
            raise RuntimeError("yfinance is not installed. Add 'yfinance' to requirements.txt")

        sym = _normalize_symbol(symbol)
        tfu = (timeframe or "").upper().strip()

        if limit <= 0:
            return []

        if limit > self.config.max_total_limit:
            raise ValueError(f"limit too high ({limit}), max={self.config.max_total_limit}")

        interval, resample_from = _yahoo_interval_for_tf(tfu)
        period = _period_for_request(tfu, limit)

        # Download (sync) inside to_thread
        df = await asyncio.to_thread(
            yf.download,
            tickers=sym,
            interval=interval,
            period=period,
            auto_adjust=self.config.auto_adjust,
            prepost=self.config.prepost,
            progress=False,
            threads=False,
        )

        if df is None or getattr(df, "empty", True):
            return []

        # If columns are multiindex (multiple tickers) pick the symbol column
        try:
            # MultiIndex columns: (PriceField, Ticker)
            if hasattr(df, "columns") and getattr(df.columns, "nlevels", 1) > 1:
                # try select sym
                if sym in df.columns.get_level_values(-1):
                    df = df.xs(sym, axis=1, level=-1)
                else:
                    # fallback first ticker
                    df = df.xs(df.columns.get_level_values(-1)[0], axis=1, level=-1)
        except Exception:
            pass

        # Build records with index timestamp
        records: list[dict[str, Any]] = []
        try:
            for idx, row in df.iterrows():
                records.append({
                    "Datetime": idx,
                    "Open": row.get("Open"),
                    "High": row.get("High"),
                    "Low": row.get("Low"),
                    "Close": row.get("Close"),
                    "Volume": row.get("Volume", 0.0),
                })
        except Exception as exc:
            raise RuntimeError(f"Failed to parse yfinance dataframe: {exc}") from exc

        # Normalize to candle dicts
        candles = DataNormalizer.normalize(
            records,
            symbol=sym,
            timeframe=("H1" if resample_from else tfu) if interval == "60m" and tfu in ("H2", "H4", "H8") else tfu,
            source="yahoo",
            strict_sort=True,
        )

        # If resampling required (H2/H4/H8), resample from hourly candles
        if tfu in ("H2", "H4", "H8"):
            candles = _resample_candles(candles, target_tf=tfu)

        # Ensure we keep only last `limit`
        if len(candles) > limit:
            candles = candles[-limit:]

        # Final: enforce symbol/timeframe
        for c in candles:
            c["symbol"] = sym
            c["timeframe"] = tfu
            c["source"] = "yahoo"
            # ensure close_time
            if c.get("open_time") is not None and c.get("close_time") is None:
                try:
                    dur_ms = _tf_minutes(tfu) * 60_000
                    c["close_time"] = int(c["open_time"] + dur_ms - 1)  # type: ignore
                except Exception:
                    pass

        return candles


# ── Helper function (import simple) ───────────────────────────────────────────

async def fetch_ohlcv(
    symbol: str,
    timeframe: str,
    *,
    limit: int = 500,
) -> list[dict[str, Any]]:
    return await YahooFetcher().fetch_ohlcv(symbol, timeframe, limit=limit)
