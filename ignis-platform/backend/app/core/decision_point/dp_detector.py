"""
core/decision_point/dp_detector.py — Decision Point (DP) detector (HLZ)

DP (Decision Point) = niveau où une décision de marché est attendue (réaction, rejet, validation, etc.)

Ce module fournit une détection unifiée des 4 types DP :
- SDP        : Successful Decision Point (HEAD tenu) — généralement fourni par sd_zones/sdp_detector
- SB_LEVEL   : Structure Breaker level (niveau cassé HH/LL) — calculé via swings / cassure récente
- TREND_LINE : Trend line / flip level (niveau dynamique) — calculé via pivots (swings)
- KEY_LEVEL  : Niveau clé (old high/low, RN, SSR flip) — fourni par key_level.py ou liste externe

Design :
- Stateless
- Tolérant : candles dict/obj
- Entrées optionnelles (zones, key_levels, market_structure) — fonctionne même en mode "light"
- Output : liste de DPResult + best DP

Notes HLZ :
- DPDetector ne remplace pas sdp_detector / key_level_detector : il ORCHESTRE et normalise.
- Les modules spécialisés peuvent enrichir via payloads (ex: zone["head_price"], zone["sdp_validated"], etc.)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

from app import DPType

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


def _safe_get(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


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


def _pct_distance(price: float, level: float) -> float:
    if level == 0:
        return 999.0
    return abs(price - level) / abs(level)


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class DPDetectorConfig:
    lookback: int = 240
    atr_period: int = 14

    # Proximity rules
    proximity_pct: float = 0.003          # 0.3% : "price at DP"
    proximity_atr_mult: float = 0.25      # alternative : proche si |price-level| <= X*ATR
    use_atr_proximity: bool = True

    # SB detection
    swing_window: int = 2                 # fractal swings
    sb_recent_bars: int = 30              # cassure doit être "récente"
    sb_min_break_atr_mult: float = 0.20   # break distance minimal (close beyond swing) en ATR

    # Trend line DP
    trendline_min_pivots: int = 2
    trendline_recent_bars: int = 80       # pivots doivent être assez récents
    trendline_proximity_atr_mult: float = 0.30

    # Key level DP
    key_level_proximity_pct: float = 0.003  # 0.3%
    key_level_proximity_atr_mult: float = 0.30

    # Weighting for scoring (0..1)
    w_proximity: float = 0.45
    w_recency: float = 0.20
    w_quality: float = 0.35


@dataclass
class DPResult:
    detected: bool = False
    dp_type: Optional[str] = None              # DPType.*
    direction: str = ""                        # "BULLISH" | "BEARISH" | ""
    level: Optional[float] = None

    is_price_at_dp: bool = False
    distance_pct: Optional[float] = None
    distance_atr: Optional[float] = None

    strength: int = 0                          # 0..100
    label: str = ""                            # human label
    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class DPDetector:
    """
    DPDetector agrège plusieurs sources/heuristiques de DP.

    detect_all() renvoie tous les DP plausibles.
    detect_best() renvoie le meilleur DP (ou detected=False si aucun).

    Inputs optionnels :
    - zones: list[dict|obj]   (pour SDP: head_price, sdp_validated, etc.)
    - key_levels: list[dict|obj] (pour KEY_LEVEL: level, type, strength)
    - market_structure: dict|obj (optionnel, peut contenir sb_level, direction, etc.)
    - current_price: float (sinon close dernière bougie)
    """

    def __init__(self, config: Optional[DPDetectorConfig] = None) -> None:
        self.config = config or DPDetectorConfig()

    def detect_best(
        self,
        candles: list[Any],
        *,
        zones: Optional[list[Any]] = None,
        key_levels: Optional[list[Any]] = None,
        market_structure: Optional[Any] = None,
        current_price: Optional[float] = None,
    ) -> DPResult:
        dps = self.detect_all(
            candles,
            zones=zones,
            key_levels=key_levels,
            market_structure=market_structure,
            current_price=current_price,
        )
        if not dps:
            return DPResult(detected=False, details={"reason": "no_dp_found"})
        return dps[0]

    def detect_all(
        self,
        candles: list[Any],
        *,
        zones: Optional[list[Any]] = None,
        key_levels: Optional[list[Any]] = None,
        market_structure: Optional[Any] = None,
        current_price: Optional[float] = None,
    ) -> list[DPResult]:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 5, 30):
            return []

        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            # on continue quand même (proximity_pct only), mais score sera moins bon
            atr = 0.0

        price = float(current_price) if current_price is not None else _c_get(candles[-1], "close")

        results: list[DPResult] = []

        # 1) SDP (depuis zones)
        if zones:
            results.extend(self._detect_sdp_from_zones(
                zones=zones,
                price=price,
                atr=atr,
                offset=0,  # zones sont déjà dans le contexte global (pas index candles)
            ))

        # 2) SB_LEVEL (depuis market_structure si fourni, sinon heuristique swings)
        ms_dp = self._detect_sb_from_market_structure(market_structure, price=price, atr=atr)
        if ms_dp:
            results.append(ms_dp)
        else:
            results.extend(self._detect_sb_from_candles(c, price=price, atr=atr, offset=offset))

        # 3) TREND_LINE (heuristique via pivots)
        results.extend(self._detect_trendline_dp(c, price=price, atr=atr, offset=offset))

        # 4) KEY_LEVEL (liste fournie)
        if key_levels:
            kl = self._detect_key_level_dp(key_levels, price=price, atr=atr)
            if kl:
                results.append(kl)

        # Final : score + sort
        scored = [self._finalize_score(r, price=price, atr=atr) for r in results if r.detected and r.level is not None]

        scored.sort(key=lambda x: x.strength, reverse=True)
        return scored

    # ──────────────────────────────────────────────────────────────────────────
    # SDP
    # ──────────────────────────────────────────────────────────────────────────

    def _detect_sdp_from_zones(
        self,
        *,
        zones: list[Any],
        price: float,
        atr: float,
        offset: int,
    ) -> list[DPResult]:
        """
        On tente d'extraire un SDP level via conventions de payload courantes :
        - zone["sdp_validated"] == True
        - zone["head_price"] ou zone["sdp_head"] ou zone["dp_level"]
        """
        cfg = self.config
        out: list[DPResult] = []

        for z in zones:
            sdp_ok = bool(_safe_get(z, "sdp_validated", False) or _safe_get(z, "is_sdp", False))
            head = (
                _safe_get(z, "head_price")
                or _safe_get(z, "sdp_head")
                or _safe_get(z, "dp_level")
                or _safe_get(z, "head")
            )

            if not sdp_ok and head is None:
                continue

            try:
                level = float(head) if head is not None else None
            except Exception:
                level = None

            if level is None or level <= 0:
                continue

            # direction : on lit zone_type si dispo
            zt = str(_safe_get(z, "zone_type", "") or _safe_get(z, "type", "")).upper()
            if "DEMAND" in zt or "FLIPPY_D" in zt or "HIDDEN_D" in zt:
                direction = "BULLISH"
            elif "SUPPLY" in zt or "FLIPPY_S" in zt or "HIDDEN_S" in zt:
                direction = "BEARISH"
            else:
                direction = ""

            out.append(DPResult(
                detected=True,
                dp_type=DPType.SDP,
                direction=direction,
                level=level,
                label="SDP (HEAD)",
                details={
                    "source": "zones",
                    "zone_type": zt,
                    "sdp_validated": sdp_ok,
                },
            ))

        return out

    # ──────────────────────────────────────────────────────────────────────────
    # SB_LEVEL
    # ──────────────────────────────────────────────────────────────────────────

    def _detect_sb_from_market_structure(
        self,
        market_structure: Any,
        *,
        price: float,
        atr: float,
    ) -> Optional[DPResult]:
        """
        Si market_structure contient déjà un SB level (plus fiable), on le prend.
        Conventions tentées :
        - market_structure["sb_level"]
        - market_structure["broken_level"]
        - market_structure["structure_break"]["level"]
        """
        if not market_structure:
            return None

        sb_level = (
            _safe_get(market_structure, "sb_level")
            or _safe_get(market_structure, "broken_level")
            or _safe_get(_safe_get(market_structure, "structure_break", {}), "level")
            or _safe_get(_safe_get(market_structure, "sb", {}), "level")
        )
        if sb_level is None:
            return None

        try:
            level = float(sb_level)
        except Exception:
            return None

        direction = str(
            _safe_get(market_structure, "direction")
            or _safe_get(_safe_get(market_structure, "structure_break", {}), "direction")
            or ""
        ).upper()
        if direction in ("UP", "BULLISH"):
            d = "BULLISH"
        elif direction in ("DOWN", "BEARISH"):
            d = "BEARISH"
        else:
            d = ""

        return DPResult(
            detected=True,
            dp_type=DPType.SB_LEVEL,
            direction=d,
            level=level,
            label="SB Level",
            details={"source": "market_structure"},
        )

    def _detect_sb_from_candles(
        self,
        candles: list[Any],
        *,
        price: float,
        atr: float,
        offset: int,
    ) -> list[DPResult]:
        """
        Heuristique : détecter une cassure de swing high/low récente.
        DP level = le swing cassé (pullback level).
        """
        cfg = self.config
        if len(candles) < 10:
            return []

        swings_hi, swings_lo = _find_swings(candles, window=cfg.swing_window)

        if not swings_hi and not swings_lo:
            return []

        last_close = _c_get(candles[-1], "close")
        out: list[DPResult] = []

        min_break = cfg.sb_min_break_atr_mult * atr if (atr and atr > 0) else 0.0

        # Bullish SB : close au-dessus dernier swing high
        if swings_hi:
            idx, lvl = swings_hi[-1]
            recent = (len(candles) - 1 - idx) <= cfg.sb_recent_bars
            if recent and last_close >= (lvl + min_break):
                out.append(DPResult(
                    detected=True,
                    dp_type=DPType.SB_LEVEL,
                    direction="BULLISH",
                    level=float(lvl),
                    label="SB Level (break swing high)",
                    details={
                        "source": "candles",
                        "swing_index": offset + idx,
                        "swing_level": lvl,
                        "last_close": last_close,
                        "min_break": min_break,
                        "recent_bars": (len(candles) - 1 - idx),
                    },
                ))

        # Bearish SB : close sous dernier swing low
        if swings_lo:
            idx, lvl = swings_lo[-1]
            recent = (len(candles) - 1 - idx) <= cfg.sb_recent_bars
            if recent and last_close <= (lvl - min_break):
                out.append(DPResult(
                    detected=True,
                    dp_type=DPType.SB_LEVEL,
                    direction="BEARISH",
                    level=float(lvl),
                    label="SB Level (break swing low)",
                    details={
                        "source": "candles",
                        "swing_index": offset + idx,
                        "swing_level": lvl,
                        "last_close": last_close,
                        "min_break": min_break,
                        "recent_bars": (len(candles) - 1 - idx),
                    },
                ))

        return out

    # ──────────────────────────────────────────────────────────────────────────
    # TREND_LINE
    # ──────────────────────────────────────────────────────────────────────────

    def _detect_trendline_dp(
        self,
        candles: list[Any],
        *,
        price: float,
        atr: float,
        offset: int,
    ) -> list[DPResult]:
        """
        Heuristique simple TrendLine DP :
        - Bullish DP (flip) : downtrend line (2 swings highs) et prix proche de la ligne
        - Bearish DP (flip) : uptrend line (2 swings lows) et prix proche de la ligne

        On ne valide pas une cassure ici : on expose un niveau dynamique "DP" pour confluence.
        """
        cfg = self.config
        if len(candles) < 30:
            return []

        swings_hi, swings_lo = _find_swings(candles, window=cfg.swing_window)

        out: list[DPResult] = []

        # Downtrend line from 2 last swing highs -> potential bullish flip DP
        if len(swings_hi) >= 2:
            (i1, p1), (i2, p2) = swings_hi[-2], swings_hi[-1]
            if (len(candles) - 1 - i1) <= cfg.trendline_recent_bars and (len(candles) - 1 - i2) <= cfg.trendline_recent_bars:
                lvl_now = _line_value_at(i1, p1, i2, p2, x=len(candles) - 1)
                if lvl_now is not None and lvl_now > 0:
                    dist = abs(price - lvl_now)
                    prox = dist <= (cfg.trendline_proximity_atr_mult * atr) if (atr and atr > 0) else (_pct_distance(price, lvl_now) <= cfg.proximity_pct)
                    if prox:
                        out.append(DPResult(
                            detected=True,
                            dp_type=DPType.TREND_LINE,
                            direction="BULLISH",
                            level=float(lvl_now),
                            label="TrendLine DP (downtrend)",
                            details={
                                "pivots": [{"index": offset + i1, "price": p1}, {"index": offset + i2, "price": p2}],
                                "line_at_last": lvl_now,
                                "distance": dist,
                            },
                        ))

        # Uptrend line from 2 last swing lows -> potential bearish flip DP
        if len(swings_lo) >= 2:
            (i1, p1), (i2, p2) = swings_lo[-2], swings_lo[-1]
            if (len(candles) - 1 - i1) <= cfg.trendline_recent_bars and (len(candles) - 1 - i2) <= cfg.trendline_recent_bars:
                lvl_now = _line_value_at(i1, p1, i2, p2, x=len(candles) - 1)
                if lvl_now is not None and lvl_now > 0:
                    dist = abs(price - lvl_now)
                    prox = dist <= (cfg.trendline_proximity_atr_mult * atr) if (atr and atr > 0) else (_pct_distance(price, lvl_now) <= cfg.proximity_pct)
                    if prox:
                        out.append(DPResult(
                            detected=True,
                            dp_type=DPType.TREND_LINE,
                            direction="BEARISH",
                            level=float(lvl_now),
                            label="TrendLine DP (uptrend)",
                            details={
                                "pivots": [{"index": offset + i1, "price": p1}, {"index": offset + i2, "price": p2}],
                                "line_at_last": lvl_now,
                                "distance": dist,
                            },
                        ))

        return out

    # ──────────────────────────────────────────────────────────────────────────
    # KEY_LEVEL
    # ──────────────────────────────────────────────────────────────────────────

    def _detect_key_level_dp(
        self,
        key_levels: list[Any],
        *,
        price: float,
        atr: float,
    ) -> Optional[DPResult]:
        """
        key_levels attendu (souple) :
          - dict: {"level": float, "type": "...", "strength": int?}
          - obj : .level, .type, .strength

        On prend le niveau le plus proche du prix (si proche).
        """
        cfg = self.config
        if not key_levels:
            return None

        best = None
        best_dist = 1e18

        for kl in key_levels:
            lvl = _safe_get(kl, "level")
            if lvl is None:
                lvl = _safe_get(kl, "price")
            try:
                lvl = float(lvl)
            except Exception:
                continue
            d = abs(price - lvl)
            if d < best_dist:
                best_dist = d
                best = kl

        if best is None:
            return None

        lvl = float(_safe_get(best, "level", _safe_get(best, "price")))
        kl_type = str(_safe_get(best, "type", _safe_get(best, "kl_type", "KEY_LEVEL")))
        kl_strength = _safe_get(best, "strength", None)

        # proximity check
        near_pct = _pct_distance(price, lvl)
        near_by_pct = near_pct <= cfg.key_level_proximity_pct
        near_by_atr = (abs(price - lvl) <= cfg.key_level_proximity_atr_mult * atr) if (atr and atr > 0) else False

        if not (near_by_pct or near_by_atr):
            return None

        return DPResult(
            detected=True,
            dp_type=DPType.KEY_LEVEL,
            direction="",
            level=lvl,
            label=f"Key Level ({kl_type})",
            details={
                "kl_type": kl_type,
                "kl_strength": kl_strength,
            },
        )

    # ──────────────────────────────────────────────────────────────────────────
    # Final scoring
    # ──────────────────────────────────────────────────────────────────────────

    def _finalize_score(self, dp: DPResult, *, price: float, atr: float) -> DPResult:
        """
        Ajoute distance, is_price_at_dp et calcule strength.
        """
        cfg = self.config
        if not dp.level or dp.level <= 0:
            dp.detected = False
            return dp

        lvl = float(dp.level)
        dist = abs(price - lvl)
        dist_pct = _pct_distance(price, lvl)
        dist_atr = (dist / atr) if (atr and atr > 0) else None

        # price at dp
        at_by_pct = dist_pct <= cfg.proximity_pct
        at_by_atr = (dist <= cfg.proximity_atr_mult * atr) if (cfg.use_atr_proximity and atr and atr > 0) else False
        at = bool(at_by_pct or at_by_atr)

        dp.is_price_at_dp = at
        dp.distance_pct = float(round(dist_pct * 100, 4))  # store in %
        dp.distance_atr = float(round(dist_atr, 4)) if dist_atr is not None else None

        # ── score components ────────────────────────────────────────────────
        # proximity score : 1 si très proche, 0 si loin
        # on normalise sur la règle la plus permissive
        if cfg.use_atr_proximity and atr and atr > 0:
            denom = max(1e-12, cfg.proximity_atr_mult * atr)
            proximity_score = _clip01(1.0 - (dist / denom))
        else:
            denom = max(1e-12, cfg.proximity_pct)
            proximity_score = _clip01(1.0 - (dist_pct / denom))

        # quality score : selon dp_type (heuristique)
        quality_score = 0.6
        if dp.dp_type == DPType.SDP:
            quality_score = 0.95
        elif dp.dp_type == DPType.SB_LEVEL:
            quality_score = 0.85
        elif dp.dp_type == DPType.TREND_LINE:
            quality_score = 0.70
        elif dp.dp_type == DPType.KEY_LEVEL:
            quality_score = 0.75

        # recency score : si on a un index, on score un peu; sinon neutre
        recency_score = 0.5
        idx = dp.details.get("swing_index") or dp.details.get("reclaim_index") or dp.details.get("index")
        if isinstance(idx, int):
            # plus récent => mieux (approx)
            # (si idx = global index, pas très important)
            recency_score = 0.7

        score01 = (
            cfg.w_proximity * proximity_score
            + cfg.w_quality * quality_score
            + cfg.w_recency * recency_score
        )
        dp.strength = int(round(100 * _clip01(score01)))

        dp.details.setdefault("scoring", {})
        dp.details["scoring"].update({
            "proximity_score01": round(proximity_score, 3),
            "quality_score01": round(quality_score, 3),
            "recency_score01": round(recency_score, 3),
            "total01": round(_clip01(score01), 3),
        })

        return dp


# ═════════════════════════════════════════════════════════════════════════════=
# Swings & geometry
# ═════════════════════════════════════════════════════════════════════════════=

def _find_swings(candles: list[Any], window: int = 2) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    """
    Fractal swings simples :
      swing high : high[i] > highs des window bougies avant et après
      swing low  : low[i]  < lows  des window bougies avant et après
    """
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


def _line_value_at(x1: int, y1: float, x2: int, y2: float, *, x: int) -> Optional[float]:
    """Valeur y de la ligne passant par (x1,y1)(x2,y2) à l'abscisse x."""
    if x2 == x1:
        return None
    m = (y2 - y1) / (x2 - x1)
    return y1 + m * (x - x1)
