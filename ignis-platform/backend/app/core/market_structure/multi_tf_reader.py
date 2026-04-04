"""
core/market_structure/multi_tf_reader.py — Multi TimeFrame Reader (HTF → LTF) (IGNIS / HLZ)

But :
- Fournir une "lecture" multi-timeframe simple et fiable.
- Aligner des bougies HTF avec des bougies LTF pour :
  • refinement des zones (Hidden Base, kisses, etc.)
  • lecture de contexte HTF sur une séquence LTF
  • navigation HTF → LTF dans le pipeline

Philosophie :
- Stateless
- Tolérant : bougies en dict ou objets (open/high/low/close + time optionnel)
- Supporte deux modes d’alignement :
  1) Alignement temporel via timestamps (recommandé)
  2) Fallback par ratio d’index (si timestamps absents)

Conventions :
- timeframes = strings ("M15","H1","H4",...)
- mapping minutes via app.TIMEFRAMES
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

from app import TIMEFRAMES, TIMEFRAME_HIERARCHY

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Candle helpers (tolérant)
# ═════════════════════════════════════════════════════════════════════════════=

@runtime_checkable
class CandleLike(Protocol):
    open: float
    high: float
    low: float
    close: float


def _c_get(c: Any, key: str, default: Any = None) -> Any:
    if isinstance(c, dict):
        return c.get(key, default)
    return getattr(c, key, default)


def _to_int_ts(v: Any) -> Optional[int]:
    """
    Normalise un timestamp vers int (ms ou s) et renvoie ms.
    Accepte :
      - int/float (s ou ms)
      - str numérique
      - datetime (via timestamp())
    """
    if v is None:
        return None

    # datetime-like
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
            # heuristic: if too small => seconds
            if v < 10_000_000_000:  # < year 2286 in seconds, typical epoch seconds ~ 1.7e9
                return int(v * 1000)
            return int(v)
    except Exception:
        return None

    return None


def _c_time_open_ms(c: Any) -> Optional[int]:
    """
    Essaie d'extraire open timestamp en ms depuis plusieurs champs usuels :
    - open_time, openTime, timestamp, t, time, ts
    """
    for k in ("open_time", "openTime", "timestamp", "t", "time", "ts"):
        ts = _to_int_ts(_c_get(c, k))
        if ts is not None:
            return ts
    return None


def _c_time_close_ms(c: Any) -> Optional[int]:
    """
    Essaie d'extraire close timestamp en ms :
    - close_time, closeTime
    fallback: open_time + duration (si duration présent)
    """
    for k in ("close_time", "closeTime"):
        ts = _to_int_ts(_c_get(c, k))
        if ts is not None:
            return ts
    # fallback: open + duration_ms
    ot = _c_time_open_ms(c)
    dur = _c_get(c, "duration_ms", None)
    dur_ms = _to_int_ts(dur) if dur is not None else None
    if ot is not None and dur_ms is not None:
        return ot + int(dur_ms)
    return None


def _tf_minutes(tf: str) -> int:
    tfu = (tf or "").upper()
    if tfu not in TIMEFRAMES:
        raise ValueError(f"Unsupported timeframe: {tf}")
    return int(TIMEFRAMES[tfu])


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class MultiTFConfig:
    """
    - allow_index_fallback : si pas de timestamps, on aligne par ratio HTF/LTF.
    - strict_time_alignment : si True, on exige que chaque candle LTF soit dans [open,close) HTF.
      Sinon, on tolère un petit drift (pratique si API fournit seulement open_time).
    """
    allow_index_fallback: bool = True
    strict_time_alignment: bool = False

    # si strict=False, on tolère un slack de +/- slack_ms au bord
    slack_ms: int = 500  # 0.5s

    # cap sécurité
    max_pairs: int = 8   # max timeframe pairs à aligner en une fois


@dataclass
class TFSeries:
    timeframe: str
    candles: list[Any]
    has_time: bool = False
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class TFAlignment:
    """
    Association d'une bougie HTF (index i) -> une fenêtre LTF [start,end] inclus.
    """
    htf_index: int
    ltf_start_index: int
    ltf_end_index: int
    ltf_count: int

    htf_open_ms: Optional[int] = None
    htf_close_ms: Optional[int] = None

    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class MultiTFResult:
    """
    Résultat global :
    - path : ex ["H4","H1","M15"]
    - alignments : dict["H4->H1"] = list[TFAlignment]
    """
    path: list[str] = field(default_factory=list)
    series: dict[str, TFSeries] = field(default_factory=dict)
    alignments: dict[str, list[TFAlignment]] = field(default_factory=dict)
    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Reader
# ═════════════════════════════════════════════════════════════════════════════=

class MultiTimeframeReader:
    """
    Reader MTF : construit des chemins HTF->LTF et aligne des séries.

    Utilisation (typique pipeline) :
        reader = MultiTimeframeReader()
        res = reader.build_alignment(
            candles_by_tf={"H4": h4, "H1": h1, "M15": m15},
            htf="H4",
            ltf="M15",
        )
        # then: res.alignments["H4->H1"], res.alignments["H1->M15"]
    """

    def __init__(self, config: Optional[MultiTFConfig] = None) -> None:
        self.config = config or MultiTFConfig()

    # ──────────────────────────────────────────────────────────────────────
    # Path utils
    # ──────────────────────────────────────────────────────────────────────

    @staticmethod
    def build_path(htf: str, ltf: str) -> list[str]:
        """
        Retourne le chemin TIMEFRAME_HIERARCHY entre htf et ltf inclus.
        Exemple: htf=H4, ltf=M15 => ["H4","H2","H1","M30","M15"] selon hierarchy.
        Si ltf est plus haut que htf => inverse.
        """
        htf_u = htf.upper()
        ltf_u = ltf.upper()

        if htf_u not in TIMEFRAME_HIERARCHY or ltf_u not in TIMEFRAME_HIERARCHY:
            raise ValueError(f"Unsupported timeframe in hierarchy: {htf_u}, {ltf_u}")

        i1 = TIMEFRAME_HIERARCHY.index(htf_u)
        i2 = TIMEFRAME_HIERARCHY.index(ltf_u)

        if i1 == i2:
            return [htf_u]

        if i1 < i2:
            # descending to LTF (MN1->...->M1)
            return TIMEFRAME_HIERARCHY[i1 : i2 + 1]
        # ascending (ltf is higher): return reversed segment
        seg = TIMEFRAME_HIERARCHY[i2 : i1 + 1]
        return list(reversed(seg))

    # ──────────────────────────────────────────────────────────────────────
    # Main API
    # ──────────────────────────────────────────────────────────────────────

    def build_alignment(
        self,
        *,
        candles_by_tf: dict[str, list[Any]],
        htf: str,
        ltf: str,
    ) -> MultiTFResult:
        """
        Aligne toutes les paires du chemin htf -> ltf.
        candles_by_tf doit contenir toutes les timeframes nécessaires du path.
        """
        cfg = self.config

        path = self.build_path(htf, ltf)
        if len(path) - 1 > cfg.max_pairs:
            raise ValueError(f"Too many TF pairs to align (>{cfg.max_pairs}). Path={path}")

        # build series objects
        series: dict[str, TFSeries] = {}
        for tf in path:
            candles = candles_by_tf.get(tf)
            if candles is None:
                raise ValueError(f"Missing candles for timeframe {tf} in candles_by_tf.")
            has_time = _c_time_open_ms(candles[0]) is not None if candles else False
            series[tf] = TFSeries(timeframe=tf, candles=candles, has_time=has_time)

        alignments: dict[str, list[TFAlignment]] = {}

        for i in range(len(path) - 1):
            a = path[i]
            b = path[i + 1]
            key = f"{a}->{b}"
            alignments[key] = self._align_pair(
                htf=a,
                ltf=b,
                htf_candles=series[a].candles,
                ltf_candles=series[b].candles,
            )

        return MultiTFResult(
            path=path,
            series=series,
            alignments=alignments,
            details={
                "mode": "timestamp" if self._has_timestamps(series[path[0]].candles) else "index_fallback",
            },
        )

    def extract_ltf_window(
        self,
        *,
        alignment: list[TFAlignment],
        ltf_candles: list[Any],
        htf_index: int,
    ) -> list[Any]:
        """
        Retourne la liste des bougies LTF correspondant à un htf_index donné.
        """
        for a in alignment:
            if a.htf_index == htf_index:
                return ltf_candles[a.ltf_start_index : a.ltf_end_index + 1]
        return []

    # ──────────────────────────────────────────────────────────────────────
    # Pair alignment
    # ──────────────────────────────────────────────────────────────────────

    def _has_timestamps(self, candles: list[Any]) -> bool:
        if not candles:
            return False
        return _c_time_open_ms(candles[0]) is not None

    def _align_pair(
        self,
        *,
        htf: str,
        ltf: str,
        htf_candles: list[Any],
        ltf_candles: list[Any],
    ) -> list[TFAlignment]:
        """
        Retourne un alignement htf_index -> [ltf_start, ltf_end].
        """
        cfg = self.config

        if not htf_candles or not ltf_candles:
            return []

        htf_min = _tf_minutes(htf)
        ltf_min = _tf_minutes(ltf)
        if ltf_min > htf_min:
            raise ValueError(f"Invalid pair: {htf} -> {ltf} (ltf is higher timeframe).")

        # Prefer time-based alignment if timestamps exist for both
        htf_has_time = _c_time_open_ms(htf_candles[0]) is not None
        ltf_has_time = _c_time_open_ms(ltf_candles[0]) is not None

        if htf_has_time and ltf_has_time:
            return self._align_pair_by_time(htf_candles=htf_candles, ltf_candles=ltf_candles, htf_min=htf_min, ltf_min=ltf_min)

        if not cfg.allow_index_fallback:
            return []

        return self._align_pair_by_index(htf_candles=htf_candles, ltf_candles=ltf_candles, htf_min=htf_min, ltf_min=ltf_min)

    def _align_pair_by_time(
        self,
        *,
        htf_candles: list[Any],
        ltf_candles: list[Any],
        htf_min: int,
        ltf_min: int,
    ) -> list[TFAlignment]:
        """
        Alignement strict par time range.
        Chaque bougie LTF est placée dans la bougie HTF correspondante via open_time.
        """
        cfg = self.config
        out: list[TFAlignment] = []

        # Precompute ltf open times
        ltf_times = [_c_time_open_ms(c) for c in ltf_candles]
        if any(t is None for t in ltf_times):
            # fallback index (rare)
            if cfg.allow_index_fallback:
                return self._align_pair_by_index(
                    htf_candles=htf_candles,
                    ltf_candles=ltf_candles,
                    htf_min=htf_min,
                    ltf_min=ltf_min,
                )
            return []

        ltf_times = [int(t) for t in ltf_times]  # type: ignore

        # Build pointer scan
        j = 0
        for i, hc in enumerate(htf_candles):
            h_open = _c_time_open_ms(hc)
            if h_open is None:
                continue
            # if no explicit close time, derive close by timeframe minutes
            h_close = _c_time_close_ms(hc)
            if h_close is None:
                h_close = int(h_open + htf_min * 60_000)

            if not cfg.strict_time_alignment:
                h_open_adj = h_open - cfg.slack_ms
                h_close_adj = h_close + cfg.slack_ms
            else:
                h_open_adj = h_open
                h_close_adj = h_close

            # Move pointer j to first ltf candle >= h_open
            while j < len(ltf_times) and ltf_times[j] < h_open_adj:
                j += 1
            if j >= len(ltf_times):
                break

            start = j
            # Include candles where open_time in [h_open, h_close)
            while j < len(ltf_times) and ltf_times[j] < h_close_adj:
                j += 1
            end = j - 1

            if end >= start:
                out.append(TFAlignment(
                    htf_index=i,
                    ltf_start_index=start,
                    ltf_end_index=end,
                    ltf_count=(end - start + 1),
                    htf_open_ms=h_open,
                    htf_close_ms=h_close,
                ))

        return out

    def _align_pair_by_index(
        self,
        *,
        htf_candles: list[Any],
        ltf_candles: list[Any],
        htf_min: int,
        ltf_min: int,
    ) -> list[TFAlignment]:
        """
        Fallback : alignement par ratio (index-based).
        Suppose un dataset régulier et complet.
        """
        out: list[TFAlignment] = []
        if ltf_min <= 0:
            return out

        ratio = max(1, int(round(htf_min / ltf_min)))
        if ratio <= 0:
            ratio = 1

        # On aligne par la FIN (plus robuste si tailles légèrement différentes)
        total_ltf = len(ltf_candles)
        for i in range(len(htf_candles)):
            start = i * ratio
            end = start + ratio - 1
            if start >= total_ltf:
                break
            end = min(end, total_ltf - 1)
            out.append(TFAlignment(
                htf_index=i,
                ltf_start_index=start,
                ltf_end_index=end,
                ltf_count=(end - start + 1),
                details={"mode": "index_fallback", "ratio": ratio},
            ))
        return out
