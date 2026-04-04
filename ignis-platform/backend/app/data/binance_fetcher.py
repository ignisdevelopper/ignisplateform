"""
data/binance_fetcher.py — Binance OHLCV Fetcher (IGNIS)

Fetch OHLCV (klines) depuis Binance (SPOT public API).
- Async (httpx)
- Pagination automatique jusqu'à 5000 bougies (cap interne) en pages de 1000 (limite Binance)
- Normalisation en dict Candle-like :
    {
        "open_time":  int (ms),
        "close_time": int (ms),
        "open":   float,
        "high":   float,
        "low":    float,
        "close":  float,
        "volume": float,
        "trades": int,
        "quote_volume": float,
        "taker_buy_base_volume": float,
        "taker_buy_quote_volume": float,
        "symbol": str,
        "timeframe": str,
        "source": "binance",
    }

Notes:
- Endpoints publics => pas besoin d'API key.
- Timeframe input: "M1","M5","M15","M30","H1","H2","H4","H8","D1","W1","MN1"
- Interval Binance: "1m","5m","15m","30m","1h","2h","4h","8h","1d","1w","1M"
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx
import structlog

from app import TIMEFRAMES, API_LIMITS

log = structlog.get_logger(__name__)

BINANCE_BASE_URL = os.getenv("BINANCE_BASE_URL", "https://api.binance.com").rstrip("/")
BINANCE_KLINES_EP = "/api/v3/klines"

# Binance limits
BINANCE_MAX_LIMIT_PER_CALL = 1000

# Network
HTTP_CONNECT_TIMEOUT = float(os.getenv("BINANCE_CONNECT_TIMEOUT", "10"))
HTTP_READ_TIMEOUT = float(os.getenv("BINANCE_READ_TIMEOUT", "30"))

# Retry
MAX_RETRY_ATTEMPTS = int(os.getenv("BINANCE_MAX_RETRY", "6"))
RETRY_BASE_DELAY = float(os.getenv("BINANCE_RETRY_BASE_DELAY", "0.8"))
RETRY_MAX_DELAY = float(os.getenv("BINANCE_RETRY_MAX_DELAY", "20"))


def _tf_to_binance_interval(timeframe: str) -> str:
    tf = (timeframe or "").upper().strip()
    mapping = {
        "M1": "1m",
        "M5": "5m",
        "M15": "15m",
        "M30": "30m",
        "H1": "1h",
        "H2": "2h",
        "H4": "4h",
        "H8": "8h",
        "D1": "1d",
        "W1": "1w",
        "MN1": "1M",
    }
    if tf not in mapping:
        raise ValueError(f"Unsupported timeframe for Binance: {timeframe}")
    return mapping[tf]


def _tf_minutes(timeframe: str) -> int:
    tf = (timeframe or "").upper().strip()
    if tf not in TIMEFRAMES:
        raise ValueError(f"Unsupported timeframe: {timeframe}")
    return int(TIMEFRAMES[tf])


def _now_ms() -> int:
    return int(time.time() * 1000)


def _parse_kline_row(row: list[Any], *, symbol: str, timeframe: str) -> dict[str, Any]:
    """
    Binance kline schema:
      0 open time (ms)
      1 open
      2 high
      3 low
      4 close
      5 volume
      6 close time (ms)
      7 quote asset volume
      8 number of trades
      9 taker buy base asset volume
      10 taker buy quote asset volume
      11 ignore
    """
    return {
        "open_time": int(row[0]),
        "open": float(row[1]),
        "high": float(row[2]),
        "low": float(row[3]),
        "close": float(row[4]),
        "volume": float(row[5]),
        "close_time": int(row[6]),
        "quote_volume": float(row[7]),
        "trades": int(row[8]),
        "taker_buy_base_volume": float(row[9]),
        "taker_buy_quote_volume": float(row[10]),
        "symbol": symbol,
        "timeframe": timeframe,
        "source": "binance",
    }


@dataclass(frozen=True)
class BinanceFetcherConfig:
    base_url: str = BINANCE_BASE_URL
    max_limit_per_call: int = BINANCE_MAX_LIMIT_PER_CALL

    connect_timeout: float = HTTP_CONNECT_TIMEOUT
    read_timeout: float = HTTP_READ_TIMEOUT

    max_retry_attempts: int = MAX_RETRY_ATTEMPTS
    retry_base_delay: float = RETRY_BASE_DELAY
    retry_max_delay: float = RETRY_MAX_DELAY

    # Hard cap safety
    max_total_limit: int = int(API_LIMITS.get("MAX_CANDLES_PER_REQUEST", 5000))


class BinanceFetcher:
    """
    Fetcher Binance async.

    Usage:
        f = BinanceFetcher()
        candles = await f.fetch_ohlcv("BTCUSDT","H4",limit=500)

    Notes:
    - Par défaut on récupère les dernières bougies (end_time = maintenant).
    - Si tu donnes start_time/end_time (ms), Binance renvoie les klines dans cette fenêtre.
    """

    def __init__(self, config: Optional[BinanceFetcherConfig] = None) -> None:
        self.config = config or BinanceFetcherConfig()

    async def fetch_ohlcv(
        self,
        symbol: str,
        timeframe: str,
        *,
        limit: int = 500,
        start_time: Optional[int] = None,
        end_time: Optional[int] = None,
    ) -> list[dict[str, Any]]:
        symbol_u = symbol.upper().strip()
        tf_u = timeframe.upper().strip()

        if limit <= 0:
            return []

        if limit > self.config.max_total_limit:
            raise ValueError(f"limit too high ({limit}), max={self.config.max_total_limit}")

        interval = _tf_to_binance_interval(tf_u)

        # Binance supports both startTime/endTime but returns up to limit and sorted asc.
        # We'll implement pagination backward using endTime to support limit > 1000.
        remaining = int(limit)
        page_limit = min(self.config.max_limit_per_call, remaining)

        # If caller gives end_time, use it; else now
        cursor_end = int(end_time) if end_time is not None else _now_ms()

        all_rows: list[list[Any]] = []

        # If start_time is provided and remaining <= 1000, single call is enough.
        # For pagination, we keep fetching earlier pages until we have enough or we reached start_time.
        while remaining > 0:
            page_limit = min(self.config.max_limit_per_call, remaining)

            params = {
                "symbol": symbol_u,
                "interval": interval,
                "limit": page_limit,
            }
            if start_time is not None:
                params["startTime"] = int(start_time)
            if cursor_end is not None:
                params["endTime"] = int(cursor_end)

            rows = await self._request_klines(params)

            if not rows:
                break

            # rows are ascending (oldest->newest)
            all_rows = rows + all_rows

            # Update for next page (earlier): endTime = first_open_time - 1
            first_open = int(rows[0][0])
            next_end = first_open - 1

            remaining -= len(rows)

            # Stop if we didn't get full page (no more history)
            if len(rows) < page_limit:
                break

            # Stop if start_time boundary reached
            if start_time is not None and next_end <= int(start_time):
                break

            cursor_end = next_end

            # Gentle delay to avoid bursts (Binance rate-limits)
            await asyncio.sleep(0.05)

        # Deduplicate by open_time (in case of overlap due to time boundaries)
        uniq: dict[int, list[Any]] = {}
        for r in all_rows:
            uniq[int(r[0])] = r
        rows_sorted = [uniq[k] for k in sorted(uniq.keys())]

        candles = [_parse_kline_row(r, symbol=symbol_u, timeframe=tf_u) for r in rows_sorted]

        # Ensure size <= limit (keep most recent)
        if len(candles) > limit:
            candles = candles[-limit:]

        return candles

    async def _request_klines(self, params: dict[str, Any]) -> list[list[Any]]:
        url = self.config.base_url + BINANCE_KLINES_EP
        timeout = httpx.Timeout(
            connect=self.config.connect_timeout,
            read=self.config.read_timeout,
            write=10.0,
            pool=5.0,
        )

        attempt = 0
        while True:
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    resp = await client.get(url, params=params)
                    # Binance sometimes returns HTML or plain text errors; handle robustly
                    if resp.status_code == 200:
                        data = resp.json()
                        if isinstance(data, list):
                            return data
                        raise RuntimeError(f"Unexpected Binance response format: {type(data)}")

                    # Retryable statuses
                    if resp.status_code in (418, 429, 500, 502, 503, 504):
                        retry_after = resp.headers.get("Retry-After")
                        if retry_after:
                            delay = min(float(retry_after), self.config.retry_max_delay)
                        else:
                            delay = min(self.config.retry_base_delay * (2 ** attempt), self.config.retry_max_delay)

                        attempt += 1
                        log.warning(
                            "binance_retry",
                            status=resp.status_code,
                            attempt=attempt,
                            delay=delay,
                            params_keys=list(params.keys()),
                        )
                        if attempt > self.config.max_retry_attempts:
                            raise RuntimeError(f"Binance max retries exceeded (status={resp.status_code})")
                        await asyncio.sleep(delay)
                        continue

                    # Non-retryable
                    try:
                        err = resp.json()
                    except Exception:
                        err = resp.text
                    raise RuntimeError(f"Binance error {resp.status_code}: {err}")

            except (httpx.ConnectError, httpx.ReadTimeout, httpx.WriteTimeout) as exc:
                attempt += 1
                delay = min(self.config.retry_base_delay * (2 ** (attempt - 1)), self.config.retry_max_delay)
                log.warning("binance_http_retry", attempt=attempt, delay=delay, error=str(exc))
                if attempt > self.config.max_retry_attempts:
                    raise RuntimeError(f"Binance fetch failed after retries: {exc}") from exc
                await asyncio.sleep(delay)


# ── Helper function (import simple) ───────────────────────────────────────────

async def fetch_ohlcv(
    symbol: str,
    timeframe: str,
    *,
    limit: int = 500,
    start_time: Optional[int] = None,
    end_time: Optional[int] = None,
) -> list[dict[str, Any]]:
    """
    Shortcut async : fetch_ohlcv("BTCUSDT","H4",limit=500)
    """
    return await BinanceFetcher().fetch_ohlcv(
        symbol=symbol,
        timeframe=timeframe,
        limit=limit,
        start_time=start_time,
        end_time=end_time,
    )
