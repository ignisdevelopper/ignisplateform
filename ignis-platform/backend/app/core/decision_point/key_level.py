"""
core/decision_point/key_level.py — Key Levels (KL) / SSR detector (HLZ)

Key Levels = niveaux de prix "importants" utilisés comme confluence Decision Point :
- OLD_HIGH / OLD_LOW : anciens sommets/creux (swings)
- ROUND_NUMBER       : nombres ronds (psychologiques)
- SSR_FLIP           : support ↔ résistance (flip) détecté via traversées + retests

Design :
- Stateless
- Tolérant candles dict/obj (open/high/low/close)
- Sortie : List[KeyLevel] triée par strength

Remarques HLZ :
- Ce module est volontairement générique. Les seuils/tolérances sont configurables.
- Le scoring est heuristique : touch count + recency + flip evidence + confluence sources.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional, Protocol, runtime_checkable

import math
import structlog

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


def _c_get(c: Any, key: str, default: float = 0.0) -> float:
    if isinstance(c, dict):
        return float(c.get(key, default))
    return float(getattr(c, key, default))


def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _compute_atr(candles: list[Any], period: int = 14) -> float:
    if len(candles) < period + 2:
        return 0.0
    trs: list[float] = []
    start = len(candles) - period - 1
    for i in range(start + 1, len(candles)):
        cur = candles[i]
        prev = candles[i - 1]
        h = _c_get(cur, "high")
        l = _c_get(cur, "low")
        pc = _c_get(prev, "close")
        tr = max(h - l, abs(h - pc), abs(l - pc))
        if tr > 0:
            trs.append(tr)
    return (sum(trs) / len(trs)) if trs else 0.0


def _pct_dist(a: float, b: float) -> float:
    if b == 0:
        return 999.0
    return abs(a - b) / abs(b)


# ═════════════════════════════════════════════════════════════════════════════=
# Models
# ═════════════════════════════════════════════════════════════════════════════=

class KeyLevelType(str, Enum):
    OLD_HIGH     = "OLD_HIGH"
    OLD_LOW      = "OLD_LOW"
    ROUND_NUMBER = "ROUND_NUMBER"
    SSR_FLIP     = "SSR_FLIP"


@dataclass
class KeyLevel:
    level: float
    type: KeyLevelType
    strength: int = 0  # 0..100

    touches: int = 0
    last_touch_index: Optional[int] = None
    first_touch_index: Optional[int] = None

    # evidence
    flip_score01: float = 0.0
    recency_score01: float = 0.0
    touch_score01: float = 0.0
    confluence_sources: set[str] = field(default_factory=set)

    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "level": self.level,
            "type": self.type.value,
            "strength": self.strength,
            "touches": self.touches,
            "last_touch_index": self.last_touch_index,
            "first_touch_index": self.first_touch_index,
            "flip_score01": round(self.flip_score01, 3),
            "recency_score01": round(self.recency_score01, 3),
            "touch_score01": round(self.touch_score01, 3),
            "sources": sorted(self.confluence_sources),
            "details": self.details,
        }


# ═════════════════════════════════════════════════════════════════════════════=
# Config
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class KeyLevelConfig:
    lookback: int = 600
    atr_period: int = 14

    # Swings
    swing_window: int = 2
    max_swing_levels: int = 25

    # Round numbers
    enable_round_numbers: bool = True
    round_step: Optional[float] = None          # si None => auto
    round_levels_above_below: int = 8           # nb de RN autour du prix actuel

    # Merge levels (dedup)
    merge_tolerance_pct: float = 0.0008         # 0.08%
    merge_tolerance_atr_mult: float = 0.15
    use_atr_merge: bool = True

    # Touch detection
    touch_tolerance_pct: float = 0.0012         # 0.12%
    touch_tolerance_atr_mult: float = 0.20
    use_atr_touch: bool = True
    min_touches: int = 2
    max_touch_count_for_score: int = 6

    # SSR flip detection
    enable_ssr_flip: bool = True
    flip_window: int = 120                      # fenêtre récente où chercher flip evidence
    flip_min_crossings: int = 2                 # traversées min du niveau
    flip_min_touches_each_side: int = 1         # retests de part et d'autre
    flip_weight: float = 0.35                   # influence dans score final

    # Recency
    max_age_bars: int = 400

    # Output
    max_levels: int = 30

    # Scoring weights (0..1)
    w_touches: float = 0.55
    w_recency: float = 0.25
    w_flip: float = 0.20


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class KeyLevelDetector:
    """
    Détecteur de Key Levels.

    Usage :
        det = KeyLevelDetector()
        levels = det.detect(candles, current_price=None)
    """

    def __init__(self, config: Optional[KeyLevelConfig] = None) -> None:
        self.config = config or KeyLevelConfig()

    def detect(
        self,
        candles: list[Any],
        *,
        current_price: Optional[float] = None,
    ) -> list[KeyLevel]:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 60):
            return []

        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        price = float(current_price) if current_price is not None else _c_get(candles[-1], "close")

        # 1) Build raw candidates: swings + round numbers
        raw_levels: list[KeyLevel] = []

        # Swings
        swings_hi, swings_lo = _find_swings(c, window=cfg.swing_window)
        # keep only most recent N to avoid noise
        swings_hi = swings_hi[-cfg.max_swing_levels :]
        swings_lo = swings_lo[-cfg.max_swing_levels :]

        for idx, lvl in swings_hi:
            raw_levels.append(KeyLevel(
                level=float(lvl),
                type=KeyLevelType.OLD_HIGH,
                confluence_sources={"swing_high"},
                details={"swing_index": offset + idx},
            ))

        for idx, lvl in swings_lo:
            raw_levels.append(KeyLevel(
                level=float(lvl),
                type=KeyLevelType.OLD_LOW,
                confluence_sources={"swing_low"},
                details={"swing_index": offset + idx},
            ))

        # Round numbers
        if cfg.enable_round_numbers:
            step = cfg.round_step or _infer_round_step(price)
            if step and step > 0:
                rn = _round_number_levels(price, step, cfg.round_levels_above_below)
                for lvl in rn:
                    raw_levels.append(KeyLevel(
                        level=float(lvl),
                        type=KeyLevelType.ROUND_NUMBER,
                        confluence_sources={"round_number"},
                        details={"round_step": step},
                    ))

        if not raw_levels:
            return []

        # 2) Merge / deduplicate close levels (confluence)
        merged = _merge_levels(
            raw_levels,
            atr=atr,
            cfg=cfg,
        )

        # 3) Touch counting + recency scoring
        for kl in merged:
            tol = _touch_tolerance(kl.level, atr=atr, cfg=cfg)
            touches, first_i, last_i, touch_meta = _count_touches(c, level=kl.level, tol=tol)
            kl.touches = touches
            kl.first_touch_index = (offset + first_i) if first_i is not None else None
            kl.last_touch_index = (offset + last_i) if last_i is not None else None
            kl.details.setdefault("touches", {}).update(touch_meta)

            # Touch score
            kl.touch_score01 = _clip01(touches / max(1, cfg.max_touch_count_for_score))

            # Recency score (if touched recently)
            if last_i is not None:
                age = (len(c) - 1) - last_i
                kl.recency_score01 = _clip01(1.0 - (age / max(1, cfg.max_age_bars)))
            else:
                kl.recency_score01 = 0.0

        # 4) SSR flip evidence (optional)
        if cfg.enable_ssr_flip:
            for kl in merged:
                flip_score, flip_meta = _ssr_flip_score(
                    c,
                    level=kl.level,
                    window=min(cfg.flip_window, len(c) - 1),
                    min_crossings=cfg.flip_min_crossings,
                    min_touches_each_side=cfg.flip_min_touches_each_side,
                    tol=_touch_tolerance(kl.level, atr=atr, cfg=cfg) * 0.9,
                )
                kl.flip_score01 = flip_score
                kl.details.setdefault("flip", {}).update(flip_meta)
                if flip_score > 0.0:
                    kl.confluence_sources.add("ssr_flip")

        # 5) Final score + filter
        scored: list[KeyLevel] = []
        for kl in merged:
            if kl.touches < cfg.min_touches and kl.type != KeyLevelType.ROUND_NUMBER:
                # Round numbers peuvent être gardés même avec 0 touches (ils servent de confluence)
                continue

            total01 = (
                cfg.w_touches * kl.touch_score01
                + cfg.w_recency * kl.recency_score01
                + cfg.w_flip * kl.flip_score01
            )

            # Bonus confluence : plus de sources => + quelques points
            conf_bonus = min(0.10, 0.03 * max(0, len(kl.confluence_sources) - 1))
            total01 = _clip01(total01 + conf_bonus)

            kl.strength = int(round(100 * total01))
            kl.details.setdefault("scoring", {}).update({
                "touch_score01": round(kl.touch_score01, 3),
                "recency_score01": round(kl.recency_score01, 3),
                "flip_score01": round(kl.flip_score01, 3),
                "confluence_bonus01": round(conf_bonus, 3),
                "total01": round(total01, 3),
            })
            scored.append(kl)

        # 6) Sort: strength desc then proximity to current price
        scored.sort(key=lambda x: (x.strength, -abs(price - x.level)), reverse=True)

        # cap
        return scored[: cfg.max_levels]

    def detect_nearest(
        self,
        candles: list[Any],
        *,
        current_price: Optional[float] = None,
        max_distance_pct: float = 0.003,
    ) -> Optional[KeyLevel]:
        """Retourne le KL le plus proche du prix si dans max_distance_pct."""
        levels = self.detect(candles, current_price=current_price)
        if not levels:
            return None
        price = float(current_price) if current_price is not None else _c_get(candles[-1], "close")
        best = min(levels, key=lambda kl: abs(price - kl.level))
        if _pct_dist(price, best.level) <= max_distance_pct:
            return best
        return None


# ═════════════════════════════════════════════════════════════════════════════=
# Internals
# ═════════════════════════════════════════════════════════════════════════════=

def _find_swings(candles: list[Any], window: int = 2) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    highs: list[tuple[int, float]] = []
    lows: list[tuple[int, float]] = []
    n = len(candles)
    w = max(1, int(window))

    for i in range(w, n - w):
        hi = _c_get(candles[i], "high")
        lo = _c_get(candles[i], "low")

        before_hi = [_c_get(candles[j], "high") for j in range(i - w, i)]
        after_hi = [_c_get(candles[j], "high") for j in range(i + 1, i + w + 1)]
        if hi > max(before_hi) and hi > max(after_hi):
            highs.append((i, hi))

        before_lo = [_c_get(candles[j], "low") for j in range(i - w, i)]
        after_lo = [_c_get(candles[j], "low") for j in range(i + 1, i + w + 1)]
        if lo < min(before_lo) and lo < min(after_lo):
            lows.append((i, lo))

    return highs, lows


def _infer_round_step(price: float) -> float:
    """
    Heuristique step RN :
    - adapte selon magnitude du prix
    Ex:
      1.2345 -> 0.01 ou 0.005 (ici 0.01)
      100 -> 10
      25000 -> 500 ou 1000 (ici 500/1000)
    """
    p = abs(price)
    if p <= 0:
        return 0.0

    # Forex-like
    if p < 5:
        return 0.01
    if p < 50:
        return 0.1
    if p < 500:
        return 1.0
    if p < 5000:
        return 10.0
    if p < 50_000:
        return 100.0
    if p < 250_000:
        return 500.0
    return 1000.0


def _round_number_levels(price: float, step: float, n: int) -> list[float]:
    if step <= 0:
        return []
    center = round(price / step) * step
    levels = [center + k * step for k in range(-n, n + 1)]
    # unique + positive
    levels = sorted({float(l) for l in levels if l > 0})
    return levels


def _merge_tolerance(level: float, atr: float, cfg: KeyLevelConfig) -> float:
    if cfg.use_atr_merge and atr and atr > 0:
        return max(cfg.merge_tolerance_atr_mult * atr, cfg.merge_tolerance_pct * level)
    return cfg.merge_tolerance_pct * level


def _touch_tolerance(level: float, atr: float, cfg: KeyLevelConfig) -> float:
    if cfg.use_atr_touch and atr and atr > 0:
        return max(cfg.touch_tolerance_atr_mult * atr, cfg.touch_tolerance_pct * level)
    return cfg.touch_tolerance_pct * level


def _merge_levels(raw: list[KeyLevel], *, atr: float, cfg: KeyLevelConfig) -> list[KeyLevel]:
    """
    Merge des niveaux proches -> confluence_sources combinées.
    Stratégie:
      - tri par level
      - cluster si |lvl_i - lvl_cluster| <= tol
      - niveau final = moyenne pondérée simple
    """
    if not raw:
        return []

    raw_sorted = sorted(raw, key=lambda x: x.level)
    out: list[KeyLevel] = []

    cur_cluster: list[KeyLevel] = []
    cur_center = raw_sorted[0].level

    def flush():
        nonlocal cur_cluster, cur_center
        if not cur_cluster:
            return
        # center as mean
        lvl = sum(k.level for k in cur_cluster) / len(cur_cluster)
        # pick dominant type (priority: SSR_FLIP > OLD_HIGH/LOW > ROUND_NUMBER)
        types = [k.type for k in cur_cluster]
        if KeyLevelType.SSR_FLIP in types:
            t = KeyLevelType.SSR_FLIP
        elif KeyLevelType.OLD_HIGH in types and KeyLevelType.OLD_LOW in types:
            # both sides around same area => flip-ish candidate
            t = KeyLevelType.SSR_FLIP
        elif KeyLevelType.OLD_HIGH in types:
            t = KeyLevelType.OLD_HIGH
        elif KeyLevelType.OLD_LOW in types:
            t = KeyLevelType.OLD_LOW
        else:
            t = KeyLevelType.ROUND_NUMBER

        merged = KeyLevel(level=float(lvl), type=t)
        for k in cur_cluster:
            merged.confluence_sources |= set(k.confluence_sources)
            # keep some evidence
            if "swing_index" in (k.details or {}):
                merged.details.setdefault("swing_indices", []).append(k.details["swing_index"])
            if "round_step" in (k.details or {}):
                merged.details["round_step"] = k.details["round_step"]

        out.append(merged)
        cur_cluster = []
        cur_center = 0.0

    for kl in raw_sorted:
        if not cur_cluster:
            cur_cluster = [kl]
            cur_center = kl.level
            continue

        tol = _merge_tolerance(cur_center, atr, cfg)
        if abs(kl.level - cur_center) <= tol:
            cur_cluster.append(kl)
            cur_center = sum(x.level for x in cur_cluster) / len(cur_cluster)
        else:
            flush()
            cur_cluster = [kl]
            cur_center = kl.level

    flush()
    return out


def _count_touches(
    candles: list[Any],
    *,
    level: float,
    tol: float,
) -> tuple[int, Optional[int], Optional[int], dict[str, Any]]:
    """
    Touch = cluster de bougies dont (high>=level-tol and low<=level+tol).
    Retourne touches_count, first_touch_index, last_touch_index, meta.
    """
    if not candles:
        return 0, None, None, {}

    touches = 0
    in_touch = False
    first_i = None
    last_i = None
    clusters: list[dict[str, int]] = []

    for i, c in enumerate(candles):
        hi = _c_get(c, "high")
        lo = _c_get(c, "low")
        hit = (lo <= (level + tol)) and (hi >= (level - tol))

        if hit and not in_touch:
            touches += 1
            in_touch = True
            if first_i is None:
                first_i = i
            last_i = i
            clusters.append({"start": i, "end": i})
        elif hit and in_touch:
            last_i = i
            clusters[-1]["end"] = i
        elif not hit and in_touch:
            in_touch = False

    return touches, first_i, last_i, {
        "touch_tol": tol,
        "clusters": clusters,
    }


def _ssr_flip_score(
    candles: list[Any],
    *,
    level: float,
    window: int,
    min_crossings: int,
    min_touches_each_side: int,
    tol: float,
) -> tuple[float, dict[str, Any]]:
    """
    SSR flip evidence:
    - crossings: nombre de fois où close passe au-dessus/au-dessous du level
    - touches each side: touches avec close>level et close<level (retests)
    """
    n = len(candles)
    if n < 10:
        return 0.0, {"enabled": True, "enough_data": False}

    w_start = max(0, n - 1 - window)
    win = candles[w_start:]

    closes = [_c_get(x, "close") for x in win]

    # crossings count
    crossings = 0
    for i in range(1, len(closes)):
        if (closes[i - 1] - level) * (closes[i] - level) < 0:
            crossings += 1

    # touches by side (close side)
    touch_up = 0
    touch_dn = 0
    for c in win:
        hi = _c_get(c, "high")
        lo = _c_get(c, "low")
        cl = _c_get(c, "close")
        hit = (lo <= (level + tol)) and (hi >= (level - tol))
        if not hit:
            continue
        if cl >= level:
            touch_up += 1
        else:
            touch_dn += 1

    ok = (crossings >= min_crossings) and (touch_up >= min_touches_each_side) and (touch_dn >= min_touches_each_side)
    if not ok:
        return 0.0, {
            "enabled": True,
            "ok": False,
            "crossings": crossings,
            "touch_up": touch_up,
            "touch_dn": touch_dn,
            "min_crossings": min_crossings,
        }

    # score: normalize crossings and balance
    cross_score = _clip01(crossings / max(1, (min_crossings + 2)))
    balance = min(touch_up, touch_dn) / max(1, max(touch_up, touch_dn))
    bal_score = _clip01(balance)

    score01 = _clip01(0.65 * cross_score + 0.35 * bal_score)
    return score01, {
        "enabled": True,
        "ok": True,
        "crossings": crossings,
        "touch_up": touch_up,
        "touch_dn": touch_dn,
        "tol": tol,
        "score01": round(score01, 3),
    }
