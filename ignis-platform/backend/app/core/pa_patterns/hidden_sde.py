"""
core/pa_patterns/hidden_sde.py — Hidden SDE (FBO + FLIPPY) detector (IGNIS / HLZ)

Hidden SDE (heuristique HLZ, version générique) :
- Contexte : une zone FLIPPY (ancienne supply→demand ou demand→supply) OU un flag "flippy".
- Pattern : FBO (Fake BreakOut) autour de la zone, puis un SDE "caché" sur LTF :
    • DEMAND/FLIPPY_D :
        1) Sweep sous la zone (breakout sous zone_bot)
        2) Reclaim rapide au-dessus de la zone (close >= zone_bot ou zone_top selon config)
        3) Engulf impulsif haussier (SDE) qui englobe une micro-base récente
    • SUPPLY/FLIPPY_S :
        1) Sweep au-dessus de la zone (breakout au-dessus zone_top)
        2) Reclaim rapide en-dessous
        3) Engulf impulsif baissier (SDE) qui englobe une micro-base

But :
- Détecter un signal PA puissant en approche/au contact de zone (souvent manipulation + absorption).

Design :
- Stateless
- Tolérant : candles dict/obj (open/high/low/close)
- Zone attendue (zone_top/zone_bot/zone_type) mais peut fonctionner avec flippy_hint.

Sortie :
- HiddenSDEResult(detected, direction, strength, indices, meta)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers (candles / zone) — tolérant dict/obj
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


def _z_get(z: Any, key: str, default: Any = None) -> Any:
    if z is None:
        return default
    if isinstance(z, dict):
        return z.get(key, default)
    return getattr(z, key, default)


def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _range(c: Any) -> float:
    return max(0.0, _c_get(c, "high") - _c_get(c, "low"))


def _body(c: Any) -> float:
    return abs(_c_get(c, "close") - _c_get(c, "open"))


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


def _normalize_zone_bounds(zone_top: float, zone_bot: float) -> tuple[float, float]:
    zt = float(zone_top)
    zb = float(zone_bot)
    return (zt, zb) if zt >= zb else (zb, zt)


def _infer_side_from_zone_type(zone_type: str) -> tuple[bool, bool, bool]:
    """
    Returns: (is_demand, is_supply, is_flippy)
    """
    zt_u = (zone_type or "").upper()
    is_demand = any(k in zt_u for k in ("DEMAND", "FLIPPY_D", "HIDDEN_D"))
    is_supply = any(k in zt_u for k in ("SUPPLY", "FLIPPY_S", "HIDDEN_S"))
    is_flippy = "FLIPPY" in zt_u
    return is_demand, is_supply, is_flippy


def _engulf_ratio(engulf_candle: Any, base_top: float, base_bot: float) -> float:
    """
    Ratio d'englobement : portion de la base couverte par le range de la candle.
    1.0 = base totalement couverte.
    """
    h = _c_get(engulf_candle, "high")
    l = _c_get(engulf_candle, "low")
    base_h = max(1e-12, base_top - base_bot)
    covered = max(0.0, min(h, base_top) - max(l, base_bot))
    return _clip01(covered / base_h)


def _is_bull(c: Any) -> bool:
    return _c_get(c, "close") > _c_get(c, "open")


def _is_bear(c: Any) -> bool:
    return _c_get(c, "close") < _c_get(c, "open")


def _close_strength(c: Any, direction: str) -> float:
    """
    0..1 : position du close dans le range.
    - bullish => close proche high
    - bearish => close proche low
    """
    h = _c_get(c, "high")
    l = _c_get(c, "low")
    cl = _c_get(c, "close")
    rng = max(1e-12, h - l)
    if direction == "BULLISH":
        return _clip01((cl - l) / rng)
    return _clip01((h - cl) / rng)


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class HiddenSDEConfig:
    lookback: int = 220
    atr_period: int = 14

    # Requirements
    require_zone: bool = True
    require_flippy: bool = False  # si True, n'accepte que zones flippy (ou flippy_hint)

    # FBO (sweep + reclaim)
    sweep_min_atr_mult: float = 0.20
    reclaim_max_bars: int = 4

    # Reclaim strictness
    reclaim_on: str = "EDGE"  # "EDGE" | "FULL"
    reclaim_buffer_atr_mult: float = 0.05
    allow_same_candle_reclaim: bool = True

    # Hidden SDE (engulf after reclaim)
    base_candles: int = 3               # micro-base length (2..6)
    base_max_height_atr_mult: float = 0.85
    base_max_avg_range_atr_mult: float = 0.75

    engulf_ratio_min: float = 0.85      # 0..1 base coverage
    min_engulf_body_to_range: float = 0.15
    min_engulf_close_strength: float = 0.55
    engulf_max_bars_after_reclaim: int = 3

    # Scoring weights
    w_sweep: float = 0.30
    w_reclaim_speed: float = 0.20
    w_engulf: float = 0.40
    w_base_quality: float = 0.10


@dataclass
class HiddenSDEResult:
    detected: bool = False
    direction: str = ""          # "BULLISH" | "BEARISH"
    strength: int = 0            # 0..100

    zone_type: Optional[str] = None
    flippy: bool = False

    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None
    atr: Optional[float] = None

    fbo_index: Optional[int] = None
    reclaim_index: Optional[int] = None
    sde_index: Optional[int] = None

    sweep_distance: Optional[float] = None
    engulf_ratio: Optional[float] = None

    base_top: Optional[float] = None
    base_bot: Optional[float] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class HiddenSDEDetector:
    """
    Hidden SDE detector.

    detect(candles, zone=..., flippy_hint=...) :
      - zone attendu: {zone_top, zone_bot, zone_type, is_flippy?}
      - flippy_hint: bool optionnel si tu veux forcer la lecture "flippy"
    """

    def __init__(self, config: Optional[HiddenSDEConfig] = None) -> None:
        self.config = config or HiddenSDEConfig()

    def detect(
        self,
        candles: list[Any],
        *,
        zone: Optional[Any] = None,
        flippy_hint: Optional[bool] = None,
    ) -> HiddenSDEResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 60):
            return HiddenSDEResult(detected=False, details={"reason": "not_enough_candles"})

        if cfg.require_zone and zone is None:
            return HiddenSDEResult(detected=False, details={"reason": "zone_required"})

        # Slice lookback
        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        offset = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            atr = 0.0

        zone_top = zone_bot = None
        zone_type = ""
        if zone is not None:
            zt = _z_get(zone, "zone_top")
            zb = _z_get(zone, "zone_bot")
            zone_type = str(_z_get(zone, "zone_type", "") or _z_get(zone, "type", "") or _z_get(zone, "zoneType", ""))
            if zt is not None and zb is not None:
                zone_top, zone_bot = _normalize_zone_bounds(float(zt), float(zb))

        if cfg.require_zone and (zone_top is None or zone_bot is None):
            return HiddenSDEResult(detected=False, details={"reason": "zone_missing_bounds"})

        # side inference
        is_demand, is_supply, z_flippy = _infer_side_from_zone_type(zone_type)
        flippy_flag = bool(flippy_hint) if flippy_hint is not None else bool(z_flippy or _z_get(zone, "is_flippy", False) if zone is not None else False)

        if cfg.require_flippy and not flippy_flag:
            return HiddenSDEResult(detected=False, zone_type=zone_type, details={"reason": "flippy_required"})

        if not (is_demand or is_supply):
            # fallback if zone_type absent: infer by price vs zone mid if possible
            if zone_top is not None and zone_bot is not None:
                last_close = _c_get(c[-1], "close")
                mid = (zone_top + zone_bot) / 2
                # if price is below zone mid => treat as demand context; else supply
                is_demand = last_close <= mid
                is_supply = not is_demand
            else:
                return HiddenSDEResult(detected=False, details={"reason": "cannot_infer_side", "zone_type": zone_type})

        direction = "BULLISH" if is_demand else "BEARISH"

        # Core thresholds
        sweep_min = cfg.sweep_min_atr_mult * atr if atr > 0 else 0.0
        reclaim_buf = cfg.reclaim_buffer_atr_mult * atr if atr > 0 else 0.0

        # Scan for the most recent FBO -> Reclaim -> Engulf
        best: Optional[HiddenSDEResult] = None
        best_strength = 0

        for fbo_i in range(len(c) - 2, max(0, len(c) - cfg.lookback) - 1, -1):
            cf = c[fbo_i]
            lo = _c_get(cf, "low")
            hi = _c_get(cf, "high")
            cl = _c_get(cf, "close")

            # 1) FBO sweep condition
            if direction == "BULLISH":
                swept = (lo <= (zone_bot - sweep_min)) if (zone_bot is not None) else False
                if not swept:
                    continue
                sweep_dist = (zone_bot - lo) if zone_bot is not None else 0.0
            else:
                swept = (hi >= (zone_top + sweep_min)) if (zone_top is not None) else False
                if not swept:
                    continue
                sweep_dist = (hi - zone_top) if zone_top is not None else 0.0

            # 2) Reclaim within reclaim_max_bars
            r_start = fbo_i if cfg.allow_same_candle_reclaim else fbo_i + 1
            r_end = min(len(c) - 1, fbo_i + cfg.reclaim_max_bars)
            reclaim_i = None

            for r in range(r_start, r_end + 1):
                cr = c[r]
                r_close = _c_get(cr, "close")

                if direction == "BULLISH":
                    # reclaim above edge or full zone
                    reclaim_level = (zone_bot + reclaim_buf) if cfg.reclaim_on == "EDGE" else (zone_top + reclaim_buf)
                    if r_close >= reclaim_level:
                        reclaim_i = r
                        break
                else:
                    reclaim_level = (zone_top - reclaim_buf) if cfg.reclaim_on == "EDGE" else (zone_bot - reclaim_buf)
                    if r_close <= reclaim_level:
                        reclaim_i = r
                        break

            if reclaim_i is None:
                continue

            # 3) Build micro-base just BEFORE reclaim (hidden base-like consolidation)
            # base window is [reclaim_i - base_candles, reclaim_i-1]
            b_len = max(2, min(6, int(cfg.base_candles)))
            b_end = reclaim_i - 1
            b_start = b_end - b_len + 1
            if b_start < 0:
                continue

            base_win = c[b_start : b_end + 1]
            if len(base_win) < 2:
                continue

            base_top = max(_c_get(x, "high") for x in base_win)
            base_bot = min(_c_get(x, "low") for x in base_win)
            base_height = base_top - base_bot
            if base_height <= 0:
                continue

            if atr > 0 and base_height > cfg.base_max_height_atr_mult * atr:
                continue

            avg_rng = sum(_range(x) for x in base_win) / len(base_win)
            if atr > 0 and avg_rng > cfg.base_max_avg_range_atr_mult * atr:
                continue

            base_quality01 = 0.5
            if atr > 0:
                h_score = _clip01(1.0 - base_height / max(1e-12, cfg.base_max_height_atr_mult * atr))
                r_score = _clip01(1.0 - avg_rng / max(1e-12, cfg.base_max_avg_range_atr_mult * atr))
                base_quality01 = _clip01(0.55 * h_score + 0.45 * r_score)

            # 4) Find engulf candle after reclaim (within engulf_max_bars_after_reclaim)
            sde_i = None
            sde_meta = None

            e_end = min(len(c) - 1, reclaim_i + cfg.engulf_max_bars_after_reclaim)
            for e in range(reclaim_i, e_end + 1):
                ce = c[e]
                e_o = _c_get(ce, "open")
                e_c = _c_get(ce, "close")
                e_h = _c_get(ce, "high")
                e_l = _c_get(ce, "low")

                # direction candle
                if direction == "BULLISH" and not _is_bull(ce):
                    continue
                if direction == "BEARISH" and not _is_bear(ce):
                    continue

                # body/range quality
                rng = max(1e-12, e_h - e_l)
                if (_body(ce) / rng) < cfg.min_engulf_body_to_range:
                    continue

                cs = _close_strength(ce, direction)
                if cs < cfg.min_engulf_close_strength:
                    continue

                # engulf ratio vs base bounds
                er = _engulf_ratio(ce, base_top, base_bot)
                if er < cfg.engulf_ratio_min:
                    continue

                sde_i = e
                sde_meta = {
                    "close_strength": cs,
                    "body_to_range": _body(ce) / rng,
                    "engulf_ratio": er,
                }
                break

            if sde_i is None:
                continue

            # 5) Scoring
            sweep_score01 = _clip01((sweep_dist / max(1e-12, sweep_min)) - 1.0) if sweep_min > 0 else 0.6
            reclaim_bars = max(1, reclaim_i - fbo_i)
            reclaim_speed01 = _clip01(1.0 - (reclaim_bars - 1) / max(1, cfg.reclaim_max_bars))

            engulf_ratio = float(sde_meta["engulf_ratio"]) if sde_meta else 0.0
            engulf_score01 = _clip01((engulf_ratio - cfg.engulf_ratio_min) / max(1e-12, (1.0 - cfg.engulf_ratio_min)))
            # incorporate close strength a bit
            engulf_score01 = _clip01(0.70 * engulf_score01 + 0.30 * _clip01((sde_meta["close_strength"] - cfg.min_engulf_close_strength) / max(1e-12, (1.0 - cfg.min_engulf_close_strength))))

            score01 = (
                cfg.w_sweep * sweep_score01
                + cfg.w_reclaim_speed * reclaim_speed01
                + cfg.w_engulf * engulf_score01
                + cfg.w_base_quality * base_quality01
            )
            strength = int(round(100 * _clip01(score01)))

            if strength >= best_strength:
                best_strength = strength
                best = HiddenSDEResult(
                    detected=True,
                    direction=direction,
                    strength=strength,
                    zone_type=zone_type or None,
                    flippy=flippy_flag,
                    zone_top=float(zone_top) if zone_top is not None else None,
                    zone_bot=float(zone_bot) if zone_bot is not None else None,
                    atr=float(atr),
                    fbo_index=offset + fbo_i,
                    reclaim_index=offset + reclaim_i,
                    sde_index=offset + sde_i,
                    sweep_distance=float(sweep_dist),
                    engulf_ratio=float(engulf_ratio),
                    base_top=float(base_top),
                    base_bot=float(base_bot),
                    details={
                        "scores01": {
                            "sweep": round(sweep_score01, 3),
                            "reclaim_speed": round(reclaim_speed01, 3),
                            "engulf": round(engulf_score01, 3),
                            "base_quality": round(base_quality01, 3),
                            "total01": round(_clip01(score01), 3),
                        },
                        "indices_local": {
                            "fbo_i": fbo_i,
                            "reclaim_i": reclaim_i,
                            "sde_i": sde_i,
                            "base_start": b_start,
                            "base_end": b_end,
                        },
                        "fbo": {
                            "sweep_min": sweep_min,
                            "reclaim_max_bars": cfg.reclaim_max_bars,
                            "reclaim_on": cfg.reclaim_on,
                            "reclaim_buffer": reclaim_buf,
                        },
                        "base": {
                            "base_height": base_height,
                            "avg_range": avg_rng,
                            "base_height_atr": round(base_height / atr, 3) if atr > 0 else None,
                            "avg_range_atr": round(avg_rng / atr, 3) if atr > 0 else None,
                        },
                        "sde": sde_meta,
                    },
                )

            # early stop if very strong found near end
            if best_strength >= 95:
                break

        if best is None:
            return HiddenSDEResult(
                detected=False,
                direction=direction,
                zone_type=zone_type or None,
                flippy=flippy_flag,
                zone_top=float(zone_top) if zone_top is not None else None,
                zone_bot=float(zone_bot) if zone_bot is not None else None,
                atr=float(atr),
                details={"reason": "no_hidden_sde_found"},
            )

        return best
