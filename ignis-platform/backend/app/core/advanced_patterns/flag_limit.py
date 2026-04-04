"""
core/advanced_patterns/flag_limit.py — Flag Limit (FL) pattern detector (HLZ)

Concept (implémentation générique et robuste) :
- Un "impulse leg" fort (rally ou drop) apparaît.
- Ensuite, une consolidation serrée (flag) se forme : ranges faibles, overlap élevé,
  canal étroit (légère dérive contre l'impulsion ou flat).
- Le "limit" correspond à la zone de rechargement :
  • Bullish FL : limit ~ bas du flag (flag_low)
  • Bearish FL : limit ~ haut du flag (flag_high)

Ce détecteur est :
- Stateless
- Tolérant (candles dict/obj)
- Indépendant des zones S&D (zone optionnelle possible plus tard si besoin)

Entrées :
- candles: list[CandleLike]

Sortie :
- FlagLimitResult (detected + direction + strength + status + levels + meta)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Candle protocol (tolérant : SQLAlchemy model / Pydantic / dict)
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


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class FlagLimitConfig:
    # Scan window
    lookback: int = 80

    # ATR
    atr_period: int = 14

    # Impulse definition
    min_impulse_candles: int = 4                 # nb bougies minimum dans l'impulsion
    max_impulse_candles: int = 14                # évite de prendre tout un trend
    min_impulse_range_atr_mult: float = 2.0      # range net (start->end) >= 2 ATR
    min_impulse_body_direction_pct: float = 0.65 # % bougies dans le sens

    # Flag definition (consolidation)
    min_flag_candles: int = 4
    max_flag_candles: int = 20
    max_flag_height_atr_mult: float = 1.2        # hauteur totale du flag (hi-lo) <= 1.2 ATR
    max_avg_candle_range_atr_mult: float = 0.55  # ranges moyens faibles
    min_overlap_ratio: float = 0.55              # overlap des ranges (proxi "compression")

    # Drift constraint (flag contre l'impulsion ou flat)
    max_flag_drift_atr_mult: float = 0.6         # drift net du close <= 0.6 ATR

    # Breakout confirmation (optionnel)
    breakout_confirm: bool = False
    breakout_buffer_atr_mult: float = 0.05       # dépassement au-dessus/au-dessous du flag

    # Scoring weights
    w_impulse: float = 0.45
    w_tightness: float = 0.35
    w_structure: float = 0.20


@dataclass
class FlagLimitResult:
    detected: bool = False
    status: str = ""              # "FORMING" | "CONFIRMED"
    direction: str = ""           # "BULLISH" | "BEARISH"
    strength: int = 0             # 0..100

    impulse_start_index: Optional[int] = None
    impulse_end_index: Optional[int] = None
    flag_start_index: Optional[int] = None
    flag_end_index: Optional[int] = None

    flag_high: Optional[float] = None
    flag_low: Optional[float] = None
    limit_price: Optional[float] = None         # prix "limit" recommandé (technique)
    breakout_level: Optional[float] = None      # niveau à casser pour confirmer
    atr: Optional[float] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class FlagLimitDetector:
    """
    Détecteur Flag Limit (HLZ).

    Heuristique :
    1) Trouver une impulsion récente forte (bullish ou bearish).
    2) Juste après, identifier une consolidation serrée (flag).
    3) Retourner les niveaux (flag_low/high, limit_price, breakout_level).
    """

    def __init__(self, config: Optional[FlagLimitConfig] = None) -> None:
        self.config = config or FlagLimitConfig()

    def detect(self, candles: list[Any]) -> FlagLimitResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 5, cfg.min_impulse_candles + cfg.min_flag_candles + 3):
            return FlagLimitResult(detected=False, details={"reason": "not_enough_candles"})

        # Slice lookback
        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        base_index = lb_start  # offset for global indices

        atr = _compute_atr(c, period=cfg.atr_period)
        if atr <= 0:
            return FlagLimitResult(detected=False, details={"reason": "atr_invalid"})

        # 1) Find best impulse ending before the last candles (so we can have a flag after)
        impulse = _find_recent_impulse(c, atr, cfg)
        if not impulse:
            return FlagLimitResult(detected=False, details={"reason": "no_impulse_found", "atr": atr})

        imp_s, imp_e, direction, imp_meta = impulse

        # 2) Find flag right after impulse
        flag = _find_flag_after_impulse(c, imp_e, direction, atr, cfg)
        if not flag:
            return FlagLimitResult(
                detected=False,
                details={
                    "reason": "no_flag_found",
                    "impulse": imp_meta,
                    "atr": atr,
                },
            )

        fl_s, fl_e, flag_high, flag_low, tight_meta = flag

        # 3) Breakout check (optional)
        status = "FORMING"
        breakout_level = None
        if direction == "BULLISH":
            breakout_level = flag_high + cfg.breakout_buffer_atr_mult * atr
            if cfg.breakout_confirm:
                last_close = _c_get(c[fl_e], "close")
                if last_close >= breakout_level:
                    status = "CONFIRMED"
                else:
                    return FlagLimitResult(
                        detected=False,
                        details={"reason": "breakout_not_confirmed", "breakout_level": breakout_level},
                    )
        else:
            breakout_level = flag_low - cfg.breakout_buffer_atr_mult * atr
            if cfg.breakout_confirm:
                last_close = _c_get(c[fl_e], "close")
                if last_close <= breakout_level:
                    status = "CONFIRMED"
                else:
                    return FlagLimitResult(
                        detected=False,
                        details={"reason": "breakout_not_confirmed", "breakout_level": breakout_level},
                    )

        # 4) Levels
        limit_price = flag_low if direction == "BULLISH" else flag_high

        # 5) Score 0..100
        impulse_score = imp_meta.get("impulse_score01", 0.0)
        tight_score = tight_meta.get("tightness_score01", 0.0)
        struct_score = tight_meta.get("structure_score01", 0.0)

        score01 = (
            cfg.w_impulse * impulse_score
            + cfg.w_tightness * tight_score
            + cfg.w_structure * struct_score
        )
        strength = int(round(100 * _clip01(score01)))

        return FlagLimitResult(
            detected=True,
            status=status,
            direction=direction,
            strength=strength,
            impulse_start_index=base_index + imp_s,
            impulse_end_index=base_index + imp_e,
            flag_start_index=base_index + fl_s,
            flag_end_index=base_index + fl_e,
            flag_high=float(flag_high),
            flag_low=float(flag_low),
            limit_price=float(limit_price),
            breakout_level=float(breakout_level) if breakout_level is not None else None,
            atr=float(atr),
            details={
                "impulse": imp_meta,
                "flag": {
                    "flag_high": flag_high,
                    "flag_low": flag_low,
                    **tight_meta,
                },
            },
        )


# ═════════════════════════════════════════════════════════════════════════════=
# Internals
# ═════════════════════════════════════════════════════════════════════════════=

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


def _is_bull(c: Any) -> bool:
    return _c_get(c, "close") > _c_get(c, "open")


def _is_bear(c: Any) -> bool:
    return _c_get(c, "close") < _c_get(c, "open")


def _range(c: Any) -> float:
    return max(0.0, _c_get(c, "high") - _c_get(c, "low"))


def _find_recent_impulse(
    candles: list[Any],
    atr: float,
    cfg: FlagLimitConfig,
) -> Optional[tuple[int, int, str, dict[str, Any]]]:
    """
    Trouve une impulsion "forte" (bullish ou bearish) la plus récente possible.
    Retourne (start_idx, end_idx, direction, meta).
    """
    n = len(candles)
    best = None
    best_score = 0.0

    # On essaie des impulsions se terminant avant la fin (il faut de la place pour le flag)
    # end_idx doit laisser au moins min_flag_candles derrière
    max_end = n - cfg.min_flag_candles - 1
    if max_end <= cfg.min_impulse_candles:
        return None

    # Scanner depuis le plus récent vers l'ancien
    for end in range(max_end, max_end - 30, -1):  # recent focus
        if end <= 2:
            break

        for length in range(cfg.min_impulse_candles, cfg.max_impulse_candles + 1):
            start = end - length + 1
            if start < 1:
                continue

            window = candles[start : end + 1]
            if not window:
                continue

            bulls = sum(1 for x in window if _is_bull(x))
            bears = sum(1 for x in window if _is_bear(x))
            frac_bull = bulls / len(window)
            frac_bear = bears / len(window)

            o0 = _c_get(window[0], "open")
            cN = _c_get(window[-1], "close")

            # Direction candidate
            if cN > o0 and frac_bull >= cfg.min_impulse_body_direction_pct:
                direction = "BULLISH"
                net = cN - o0
                frac = frac_bull
            elif cN < o0 and frac_bear >= cfg.min_impulse_body_direction_pct:
                direction = "BEARISH"
                net = o0 - cN
                frac = frac_bear
            else:
                continue

            if net < cfg.min_impulse_range_atr_mult * atr:
                continue

            # score: fraction + amplitude
            amp_score = _clip01(net / (cfg.min_impulse_range_atr_mult * atr) - 1.0)
            frac_score = _clip01((frac - cfg.min_impulse_body_direction_pct) / max(1e-9, (1.0 - cfg.min_impulse_body_direction_pct)))
            score01 = 0.6 * frac_score + 0.4 * amp_score

            if score01 > best_score:
                best_score = score01
                best = (start, end, direction, {
                    "start": start,
                    "end": end,
                    "direction": direction,
                    "net_move": net,
                    "atr": atr,
                    "frac_directional": round(frac, 3),
                    "impulse_score01": round(score01, 3),
                })

    return best


def _find_flag_after_impulse(
    candles: list[Any],
    impulse_end: int,
    direction: str,
    atr: float,
    cfg: FlagLimitConfig,
) -> Optional[tuple[int, int, float, float, dict[str, Any]]]:
    """
    Cherche une consolidation (flag) immédiatement après impulse_end.
    Retourne (flag_start, flag_end, flag_high, flag_low, meta).
    """
    n = len(candles)
    flag_start = impulse_end + 1
    if flag_start >= n - 1:
        return None

    best = None
    best_score = 0.0

    max_end = min(n - 1, flag_start + cfg.max_flag_candles - 1)

    for end in range(flag_start + cfg.min_flag_candles - 1, max_end + 1):
        window = candles[flag_start : end + 1]
        if len(window) < cfg.min_flag_candles:
            continue

        hi = max(_c_get(x, "high") for x in window)
        lo = min(_c_get(x, "low") for x in window)
        height = hi - lo

        if height <= 0:
            continue
        if height > cfg.max_flag_height_atr_mult * atr:
            continue

        avg_rng = sum(_range(x) for x in window) / len(window)
        if avg_rng > cfg.max_avg_candle_range_atr_mult * atr:
            continue

        # Overlap ratio : proportion de bougies dont le range chevauche le range précédent
        overlaps = 0
        for i in range(1, len(window)):
            a = window[i - 1]
            b = window[i]
            a_hi, a_lo = _c_get(a, "high"), _c_get(a, "low")
            b_hi, b_lo = _c_get(b, "high"), _c_get(b, "low")
            if not (b_hi < a_lo or b_lo > a_hi):
                overlaps += 1
        overlap_ratio = overlaps / max(1, (len(window) - 1))
        if overlap_ratio < cfg.min_overlap_ratio:
            continue

        # Drift : flag doit dériver peu (et souvent contre l'impulsion)
        c0 = _c_get(window[0], "close")
        cN = _c_get(window[-1], "close")
        drift = abs(cN - c0)
        if drift > cfg.max_flag_drift_atr_mult * atr:
            continue

        # Directional structure score (drift sign)
        # Bullish flag : drift idéalement <=0 (léger pullback) ; Bearish : drift idéalement >=0
        drift_signed = (cN - c0)
        if direction == "BULLISH":
            struct_ok = drift_signed <= 0.0
        else:
            struct_ok = drift_signed >= 0.0

        struct_score01 = 1.0 if struct_ok else 0.5  # tolérant : sideways OK

        # Tightness score: plus height et avg_rng sont faibles, plus c'est fort
        height_score = _clip01(1.0 - (height / (cfg.max_flag_height_atr_mult * atr)))
        rng_score = _clip01(1.0 - (avg_rng / (cfg.max_avg_candle_range_atr_mult * atr)))
        overlap_score = _clip01((overlap_ratio - cfg.min_overlap_ratio) / max(1e-9, (1.0 - cfg.min_overlap_ratio)))

        tightness_score01 = _clip01(0.45 * height_score + 0.35 * rng_score + 0.20 * overlap_score)

        # Best by tightness (on veut la consolidation la plus "serrée" et récente)
        score01 = 0.75 * tightness_score01 + 0.25 * struct_score01
        if score01 >= best_score:
            best_score = score01
            best = (
                flag_start,
                end,
                hi,
                lo,
                {
                    "flag_len": len(window),
                    "flag_height": height,
                    "avg_candle_range": avg_rng,
                    "overlap_ratio": round(overlap_ratio, 3),
                    "drift": drift,
                    "drift_signed": drift_signed,
                    "tightness_score01": round(tightness_score01, 3),
                    "structure_score01": round(struct_score01, 3),
                }
            )

    return best