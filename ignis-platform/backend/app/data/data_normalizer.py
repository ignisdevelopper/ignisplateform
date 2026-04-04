"""
data/data_normalizer.py — Normalisation des données OHLCV (IGNIS)

Objectif :
- Convertir des sources hétérogènes (Binance, Yahoo/yfinance, CSV, dict custom)
  vers un format unifié Candle-like utilisable par tous les détecteurs HLZ.

Format unifié (dict) retourné :
{
  "open_time":  int|None   (ms UTC)
  "close_time": int|None   (ms UTC)
  "open":   float
  "high":   float
  "low":    float
  "close":  float
  "volume": float
  "symbol": str
  "timeframe": str
  "source": str
}

Notes :
- Les détecteurs IGNIS n'exigent pas forcément open_time/close_time, mais le MTF en profite.
- Si close_time est manquant et open_time présent, on le dérive via timeframe (minutes).
- Tolérant : ignore les lignes invalides (NaN, valeurs <=0 si incohérentes).
"""

from __future__ import annotations

from dataclasses import dataclass, asdict, is_dataclass
from datetime import datetime, timezone
from typing import Any, Optional

import math
import structlog

from app import TIMEFRAMES

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass
class CandleDTO:
    open_time: Optional[int]
    close_time: Optional[int]
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    symbol: str = ""
    timeframe: str = ""
    source: str = "unknown"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers
# ═════════════════════════════════════════════════════════════════════════════=

def _tf_minutes(timeframe: str) -> int:
    tfu = (timeframe or "").upper().strip()
    if tfu not in TIMEFRAMES:
        raise ValueError(f"Unsupported timeframe: {timeframe}")
    return int(TIMEFRAMES[tfu])


def _to_ms(v: Any) -> Optional[int]:
    """
    Convertit un timestamp en ms.
    Accepte :
      - datetime
      - int/float (s ou ms)
      - str numérique
    """
    if v is None:
        return None

    if hasattr(v, "timestamp"):
        try:
            return int(v.timestamp() * 1000)
        except Exception:
            return None

    try:
        if isinstance(v, str):
            v = v.strip()
            if not v:
                return None
            v = float(v)

        if isinstance(v, (int, float)):
            # heuristic seconds vs ms
            if v < 10_000_000_000:  # seconds epoch ~ 1.7e9
                return int(v * 1000)
            return int(v)
    except Exception:
        return None

    return None


def _is_finite(x: Any) -> bool:
    try:
        return math.isfinite(float(x))
    except Exception:
        return False


def _f(x: Any, default: float = 0.0) -> float:
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except Exception:
        return default


def _get(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _derive_close_time(open_time_ms: Optional[int], timeframe: str) -> Optional[int]:
    if open_time_ms is None:
        return None
    try:
        dur_ms = _tf_minutes(timeframe) * 60_000
        # close_time inclusive-ish, ok for alignment
        return int(open_time_ms + dur_ms - 1)
    except Exception:
        return None


# ═════════════════════════════════════════════════════════════════════════════=
# Normalizer
# ═════════════════════════════════════════════════════════════════════════════=

class DataNormalizer:
    """
    Normaliseur de bougies.

    Méthode principale :
        normalize(data, symbol, timeframe, source="binance|yahoo|custom")

    Retour :
        list[dict] Candle-like
    """

    @classmethod
    def normalize(
        cls,
        data: Any,
        *,
        symbol: str,
        timeframe: str,
        source: str = "unknown",
        strict_sort: bool = True,
    ) -> list[dict[str, Any]]:
        """
        Normalise une série de bougies provenant de :
        - list[dict]
        - list[list] (format Binance raw klines)
        - list[objects] (avec attributs open/high/low/close)
        - pandas.DataFrame (optionnel, sans dépendance explicite)
        """
        symbol_u = (symbol or "").upper().strip()
        tf_u = (timeframe or "").upper().strip()
        src = (source or "unknown").strip()

        if data is None:
            return []

        # pandas.DataFrame support (sans import pandas)
        if hasattr(data, "to_dict") and hasattr(data, "columns"):
            try:
                # yfinance df often has index datetime
                records = cls._from_dataframe(data)
                return cls.normalize(records, symbol=symbol_u, timeframe=tf_u, source=src, strict_sort=strict_sort)
            except Exception as exc:
                log.warning("normalize_dataframe_failed", error=str(exc))

        # If object has attribute "candles"
        if not isinstance(data, list) and hasattr(data, "candles"):
            data = getattr(data, "candles")

        if not isinstance(data, list):
            # last resort: try iterate
            try:
                data = list(data)
            except Exception:
                return []

        if not data:
            return []

        # Detect Binance kline raw list rows
        if isinstance(data[0], (list, tuple)) and len(data[0]) >= 6:
            candles = [cls._from_binance_row(row, symbol_u, tf_u, src) for row in data]
        else:
            candles = [cls._from_any_row(row, symbol_u, tf_u, src) for row in data]

        # filter invalid
        candles = [c for c in candles if c is not None]
        if not candles:
            return []

        # dedup by open_time if exists
        uniq: dict[int, dict[str, Any]] = {}
        no_time: list[dict[str, Any]] = []
        for c in candles:
            ot = c.get("open_time")
            if isinstance(ot, int):
                uniq[ot] = c
            else:
                no_time.append(c)

        merged = list(uniq.values())
        if strict_sort and merged and isinstance(merged[0].get("open_time"), int):
            merged.sort(key=lambda x: x["open_time"])  # type: ignore

        # append no-time at end, preserving order
        merged.extend(no_time)

        return merged

    # ──────────────────────────────────────────────────────────────────────
    # Parsers
    # ──────────────────────────────────────────────────────────────────────

    @staticmethod
    def _from_binance_row(row: list[Any], symbol: str, timeframe: str, source: str) -> Optional[dict[str, Any]]:
        """
        Binance raw row schema:
          0 open time (ms)
          1 open
          2 high
          3 low
          4 close
          5 volume
          6 close time (ms)
          ...
        """
        try:
            ot = _to_ms(row[0])
            ct = _to_ms(row[6]) if len(row) > 6 else None
            o = _f(row[1])
            h = _f(row[2])
            l = _f(row[3])
            c = _f(row[4])
            v = _f(row[5], 0.0)

            if not (_is_finite(o) and _is_finite(h) and _is_finite(l) and _is_finite(c)):
                return None
            if h < l:
                return None

            if ct is None:
                ct = _derive_close_time(ot, timeframe)

            return {
                "open_time": ot,
                "close_time": ct,
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": v,
                "symbol": symbol,
                "timeframe": timeframe,
                "source": source or "binance",
            }
        except Exception:
            return None

    @staticmethod
    def _from_any_row(row: Any, symbol: str, timeframe: str, source: str) -> Optional[dict[str, Any]]:
        """
        Supporte :
        - dict keys: open/high/low/close (+ open_time/close_time) ou variantes
        - object attributes: open/high/low/close
        - yfinance-like dict: Open/High/Low/Close/Volume (+ Datetime/Date/index)
        """
        if row is None:
            return None

        # dict-like
        if isinstance(row, dict):
            # common variants
            ot = (
                _to_ms(row.get("open_time"))
                or _to_ms(row.get("openTime"))
                or _to_ms(row.get("timestamp"))
                or _to_ms(row.get("time"))
                or _to_ms(row.get("t"))
                or _to_ms(row.get("Datetime"))
                or _to_ms(row.get("Date"))
            )
            ct = _to_ms(row.get("close_time")) or _to_ms(row.get("closeTime"))

            o = row.get("open", row.get("Open", None))
            h = row.get("high", row.get("High", None))
            l = row.get("low", row.get("Low", None))
            c = row.get("close", row.get("Close", None))
            v = row.get("volume", row.get("Volume", 0.0))

            o = _f(o)
            h = _f(h)
            l = _f(l)
            c = _f(c)
            v = _f(v, 0.0)

            if not (_is_finite(o) and _is_finite(h) and _is_finite(l) and _is_finite(c)):
                return None
            if h < l:
                return None

            if ct is None:
                ct = _derive_close_time(ot, timeframe)

            return {
                "open_time": ot,
                "close_time": ct,
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": v,
                "symbol": row.get("symbol", symbol) or symbol,
                "timeframe": row.get("timeframe", timeframe) or timeframe,
                "source": row.get("source", source) or source,
            }

        # dataclass / pydantic / object with attributes
        try:
            ot = _to_ms(
                _get(row, "open_time")
                or _get(row, "openTime")
                or _get(row, "timestamp")
                or _get(row, "time")
            )
            ct = _to_ms(_get(row, "close_time") or _get(row, "closeTime"))

            o = _f(_get(row, "open", _get(row, "Open", 0.0)))
            h = _f(_get(row, "high", _get(row, "High", 0.0)))
            l = _f(_get(row, "low", _get(row, "Low", 0.0)))
            c = _f(_get(row, "close", _get(row, "Close", 0.0)))
            v = _f(_get(row, "volume", _get(row, "Volume", 0.0)), 0.0)

            if not (_is_finite(o) and _is_finite(h) and _is_finite(l) and _is_finite(c)):
                return None
            if h < l:
                return None

            if ct is None:
                ct = _derive_close_time(ot, timeframe)

            return {
                "open_time": ot,
                "close_time": ct,
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": v,
                "symbol": str(_get(row, "symbol", symbol) or symbol).upper(),
                "timeframe": str(_get(row, "timeframe", timeframe) or timeframe).upper(),
                "source": str(_get(row, "source", source) or source),
            }
        except Exception:
            return None

    @staticmethod
    def _from_dataframe(df: Any) -> list[dict[str, Any]]:
        """
        Convertit un DataFrame (yfinance) vers list[dict].
        Sans dépendre explicitement de pandas.
        """
        # yfinance columns often: Open High Low Close Volume
        cols = {str(c): c for c in getattr(df, "columns", [])}
        needed = any(k in cols for k in ("Open", "open", "High", "high", "Low", "low", "Close", "close"))
        if not needed:
            # fallback to records
            return df.to_dict("records")  # type: ignore

        # Prefer iterrows to keep index timestamps
        out: list[dict[str, Any]] = []
        for idx, row in df.iterrows():  # type: ignore
            # idx is usually Timestamp/datetime
            out.append({
                "Datetime": idx,
                "Open": float(row[cols.get("Open", cols.get("open"))]) if ("Open" in cols or "open" in cols) else None,
                "High": float(row[cols.get("High", cols.get("high"))]) if ("High" in cols or "high" in cols) else None,
                "Low": float(row[cols.get("Low", cols.get("low"))]) if ("Low" in cols or "low" in cols) else None,
                "Close": float(row[cols.get("Close", cols.get("close"))]) if ("Close" in cols or "close" in cols) else None,
                "Volume": float(row[cols.get("Volume", cols.get("volume"))]) if ("Volume" in cols or "volume" in cols) else 0.0,
            })
        return out
