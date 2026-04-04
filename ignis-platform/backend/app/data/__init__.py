"""
data/__init__.py — Package Data IGNIS
Sources de données (OHLCV), normalisation, cache.

Expose :
- Fetchers : BinanceFetcher / YahooFetcher + helpers fetch_ohlcv()
- Normalizer : DataNormalizer / Candle schema helpers
- Cache : CacheManager (Redis + fallback mémoire)

Note :
- Les fetchers peuvent être synchrones ou async selon ton implémentation.
- Ce __init__ fournit des imports "safe" (try/except) pour éviter de casser
  l'app si un module n'est pas encore finalisé.
"""

from __future__ import annotations

from typing import Any

# ── Fetchers ────────────────────────────────────────────────────────────────
try:
    from app.data.binance_fetcher import BinanceFetcher, fetch_ohlcv as fetch_binance_ohlcv  # type: ignore
except Exception:  # pragma: no cover
    BinanceFetcher = None  # type: ignore
    fetch_binance_ohlcv = None  # type: ignore

try:
    from app.data.yahoo_fetcher import YahooFetcher, fetch_ohlcv as fetch_yahoo_ohlcv  # type: ignore
except Exception:  # pragma: no cover
    YahooFetcher = None  # type: ignore
    fetch_yahoo_ohlcv = None  # type: ignore

# ── Normalizer ──────────────────────────────────────────────────────────────
try:
    from app.data.data_normalizer import DataNormalizer, CandleDTO  # type: ignore
except Exception:  # pragma: no cover
    DataNormalizer = None  # type: ignore
    CandleDTO = None  # type: ignore

# ── Cache ───────────────────────────────────────────────────────────────────
try:
    from app.data.cache_manager import CacheManager  # type: ignore
except Exception:  # pragma: no cover
    CacheManager = None  # type: ignore


__all__ = [
    # Fetchers
    "BinanceFetcher",
    "YahooFetcher",
    "fetch_binance_ohlcv",
    "fetch_yahoo_ohlcv",

    # Normalizer
    "DataNormalizer",
    "CandleDTO",

    # Cache
    "CacheManager",
]