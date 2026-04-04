"""
core/advanced_patterns/ignored_accu.py — Ignored Accumulation (IA) detector (HLZ)

Pattern "Ignored Accu" (heuristique HLZ, version robuste/générique) :

Contexte :
- Un prix approche une zone S&D (DEMAND ou SUPPLY).
- Un pattern de compression / escalier (ACCU) se forme pendant l’approche :
  • Vers DEMAND : swing highs qui baissent (lower highs) = compression baissière.
  • Vers SUPPLY : swing lows qui montent (higher lows) = compression haussière.
- Puis le marché fait un "fake break" AWAY from the zone (cassure dans le sens opposé
  à l’approche), mais ce break est IGNORÉ : le prix revient rapidement toucher la zone.

Interprétation (HLZ) :
- Le break "away" échoué + retour violent vers la zone = absorption / intention forte,
  souvent un signal de probabilité élevée de réaction sur zone (si le reste est aligné).

Ce détecteur est :
- Stateless
- Tolérant aux candles dict/obj
- Nécessite une zone (zone_top, zone_bot, zone_type)

Entrées :
- candles: list[CandleLike]
- zone: dict|object avec zone_top/zone_bot/zone_type

Sortie :
- IgnoredAccuResult(detected, direction, strength, indices, niveaux, details)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Candle / Zone helpers (tolérant)
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


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class IgnoredAccuConfig:
    # Scan
    lookback: int = 120

    # Swings (fractal)
    swing_window: int = 2                 # 2 => compare aux 2 bougies avant/après
    min_steps: int = 3                    # nb min de swings (stairs) pour qualifier l'accu
    max_steps: int = 7

    # ATR
    atr_period: int = 14

    # Qualité de l'escalier (anti-bruit)
    min_step_delta_atr_mult: float = 0.15   # différence min entre swings successifs (en ATR)

    # Break "away from zone" (le break ignoré)
    min_break_distance_atr_mult: float = 0.35  # close au-delà du swing_level d'au moins X*ATR
    max_bars_after_break_to_zone: int = 12     # le prix doit retoucher la zone rapidement
    require_break_close: bool = True

    # Zone touch
    zone_touch_mode: str = "overlap"      # "overlap" | "penetration"
    min_penetration_pct: float = 0.0      # 0..1 (0 = simple touch). Ex: 0.2 = 20% dans la zone

    # Scoring weights (0..1)
    w_steps: float = 0.35
    w_break: float = 0.30
    w_speed: float = 0.20
    w_penetration: float = 0.15


@dataclass
class IgnoredAccuResult:
    detected: bool = False
    direction: str = ""                 # "BULLISH" | "BEARISH" (direction attendue de la zone)
    strength: int = 0                   # 0..100

    zone_type: Optional[str] = None
    steps: int = 0

    # Indices (dans la série complète fournie)
    accu_start_index: Optional[int] = None
    accu_end_index: Optional[int] = None
    break_index: Optional[int] = None
    zone_hit_index: Optional[int] = None

    # Niveaux
    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None
    break_level: Optional[float] = None  # swing cassé lors du fake break
    break_close: Optional[float] = None

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class IgnoredAccuDetector:
    """
    Détecte un IA (Ignored Accu) autour d'une zone S&D.

    Convention :
    - Zone DEMAND => direction setup "BULLISH"
      Accu typique : lower swing highs (compression vers le bas)
      Break ignoré : fake break UP (away from zone) puis retour toucher zone.
    - Zone SUPPLY => direction setup "BEARISH"
      Accu typique : higher swing lows (compression vers le haut)
      Break ignoré : fake break DOWN puis retour toucher zone.
    """

    def __init__(self, config: Optional[IgnoredAccuConfig] = None) -> None:
        self.config = config or IgnoredAccuConfig()

    def detect(self, candles: list[Any], zone: Any) -> IgnoredAccuResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 10, 50):
            return IgnoredAccuResult(detected=False, details={"reason": "not_enough_candles"})

        if zone is None:
            return IgnoredAccuResult(detected=False, details={"reason": "zone_required"})

        zone_top = _z_get(zone, "zone_top")
        zone_bot = _z_get(zone, "zone_bot")
        zt = _z_get(zone, "zone_type") or _z_get(zone, "type") or _z_get(zone, "zoneType") or ""
        zt_u = str(zt).upper()

        if zone_top is None or zone_bot is None:
            return IgnoredAccuResult(detected=False, details={"reason": "zone_missing_bounds"})

        zone_top = float(zone_top)
        zone_bot = float(zone_bot)
        if zone_top < zone_bot:
            zone_top, zone_bot = zone_bot, zone_top

        is_demand = any(k in zt_u for k in ("DEMAND", "FLIPPY_D", "HIDDEN_D"))
        is_supply = any(k in zt_u for k in ("SUPPLY", "FLIPPY_S", "HIDDEN_S"))
        if not (is_demand or is_supply):
            return IgnoredAccuResult(detected=False, details={"reason": "unknown_zone_type", "zone_type": zt})

        direction = "BULLISH" if is_demand else "BEARISH"

        # Focus window
        lb_start = max(0, len(candles) - cfg.lookback)
        c = candles[lb_start:]
        base_index = lb_start

        atr = _compute_atr(c, cfg.atr_period)
        if atr <= 0:
            return IgnoredAccuResult(detected=False, details={"reason": "atr_invalid"})

        # 1) Swings
        swings_high, swings_low = _find_swings(c, window=cfg.swing_window)

        # 2) Detect ACCU staircase near end (we want the most recent valid staircase)
        if is_demand:
            # staircase: lower highs
            stair = _extract_staircase(
                swings=swings_high,
                mode="lower_highs",
                atr=atr,
                min_steps=cfg.min_steps,
                max_steps=cfg.max_steps,
                min_step_delta_atr_mult=cfg.min_step_delta_atr_mult,
            )
        else:
            # staircase: higher lows
            stair = _extract_staircase(
                swings=swings_low,
                mode="higher_lows",
                atr=atr,
                min_steps=cfg.min_steps,
                max_steps=cfg.max_steps,
                min_step_delta_atr_mult=cfg.min_step_delta_atr_mult,
            )

        if stair is None:
            return IgnoredAccuResult(detected=False, details={"reason": "no_accu_staircase"})

        stair_indices, stair_prices = stair
        accu_start = min(stair_indices)
        accu_end = max(stair_indices)
        steps = len(stair_indices)

        # 3) Identify the "break away from zone" after the staircase ends
        # Demand: fake break UP above last swing high
        # Supply: fake break DOWN below last swing low
        last_swing_idx = stair_indices[-1]
        last_swing_level = stair_prices[-1]

        break_idx, break_close, break_level = _find_fake_break_away(
            candles=c,
            start_index=last_swing_idx + 1,
            direction=direction,
            swing_level=last_swing_level,
            atr=atr,
            min_break_atr_mult=cfg.min_break_distance_atr_mult,
            require_close=cfg.require_break_close,
        )
        if break_idx is None:
            return IgnoredAccuResult(
                detected=False,
                zone_type=str(zt),
                direction=direction,
                steps=steps,
                details={
                    "reason": "no_fake_break_away",
                    "accu": {"start": accu_start, "end": accu_end, "steps": steps, "last_swing_level": last_swing_level},
                },
            )

        # 4) Verify zone is still hit quickly after the break => "ignored"
        zone_hit_idx, penetration_pct = _find_zone_hit_after(
            candles=c,
            start_index=break_idx + 1,
            zone_top=zone_top,
            zone_bot=zone_bot,
            direction=direction,
            max_bars=cfg.max_bars_after_break_to_zone,
            touch_mode=cfg.zone_touch_mode,
        )
        if zone_hit_idx is None:
            return IgnoredAccuResult(
                detected=False,
                zone_type=str(zt),
                direction=direction,
                steps=steps,
                details={
                    "reason": "no_zone_hit_after_break",
                    "break": {"index": break_idx, "close": break_close, "level": break_level},
                    "max_bars_after_break_to_zone": cfg.max_bars_after_break_to_zone,
                },
            )

        if penetration_pct < cfg.min_penetration_pct:
            return IgnoredAccuResult(
                detected=False,
                zone_type=str(zt),
                direction=direction,
                steps=steps,
                details={
                    "reason": "zone_penetration_too_small",
                    "penetration_pct": penetration_pct,
                    "min_penetration_pct": cfg.min_penetration_pct,
                },
            )

        # 5) Scoring 0..100
        # steps_score: more steps => better up to max_steps
        steps_score = _clip01((steps - cfg.min_steps) / max(1e-9, (cfg.max_steps - cfg.min_steps)))

        # break_score: distance of break close from swing level in ATR
        break_dist = abs(break_close - break_level)
        break_score = _clip01(break_dist / max(1e-9, (cfg.min_break_distance_atr_mult * atr)) - 1.0)

        # speed_score: faster return => stronger
        bars_to_zone = max(1, zone_hit_idx - break_idx)
        speed_score = _clip01(1.0 - (bars_to_zone - 1) / max(1, cfg.max_bars_after_break_to_zone))

        # penetration_score: normalized 0..1
        penetration_score = _clip01(penetration_pct)

        score01 = (
            cfg.w_steps * steps_score
            + cfg.w_break * break_score
            + cfg.w_speed * speed_score
            + cfg.w_penetration * penetration_score
        )
        strength = int(round(100 * _clip01(score01)))

        return IgnoredAccuResult(
            detected=True,
            direction=direction,
            strength=strength,
            zone_type=str(zt),
            steps=steps,
            accu_start_index=base_index + accu_start,
            accu_end_index=base_index + accu_end,
            break_index=base_index + break_idx,
            zone_hit_index=base_index + zone_hit_idx,
            zone_top=zone_top,
            zone_bot=zone_bot,
            break_level=float(break_level),
            break_close=float(break_close),
            details={
                "atr": atr,
                "scores": {
                    "steps": round(steps_score, 3),
                    "break": round(break_score, 3),
                    "speed": round(speed_score, 3),
                    "penetration": round(penetration_score, 3),
                },
                "accu": {
                    "stairs": [{"index": base_index + i, "price": p} for i, p in zip(stair_indices, stair_prices)],
                    "mode": "lower_highs" if is_demand else "higher_lows",
                },
                "break": {
                    "index": base_index + break_idx,
                    "swing_level": break_level,
                    "close": break_close,
                    "distance_atr": round(break_dist / atr, 3) if atr > 0 else None,
                },
                "zone_hit": {
                    "index": base_index + zone_hit_idx,
                    "penetration_pct": round(penetration_pct, 3),
                    "bars_after_break": bars_to_zone,
                },
            },
        )


# ═════════════════════════════════════════════════════════════════════════════=
# Internals
# ═════════════════════════════════════════════════════════════════════════════=

def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _compute_atr(candles: list[Any], period: int) -> float:
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


def _find_swings(candles: list[Any], window: int = 2) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    """
    Swings fractals simples :
    swing high : high[i] > highs des window bougies avant/après
    swing low  : low[i]  < lows  des window bougies avant/après
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


def _extract_staircase(
    *,
    swings: list[tuple[int, float]],
    mode: str,  # "lower_highs" | "higher_lows"
    atr: float,
    min_steps: int,
    max_steps: int,
    min_step_delta_atr_mult: float,
) -> Optional[tuple[list[int], list[float]]]:
    """
    Prend la fin de la liste de swings et extrait la plus récente suite monotone.
    """
    if len(swings) < min_steps:
        return None

    # On travaille sur les swings les plus récents
    recent = swings[-(max_steps + 3) :]  # un peu plus pour pouvoir former une suite
    idxs = [i for i, _ in recent]
    vals = [p for _, p in recent]

    # On cherche la meilleure "run" en fin de série (la plus récente)
    run_idxs: list[int] = []
    run_vals: list[float] = []

    for k in range(len(recent) - 1, -1, -1):
        i, p = recent[k]
        if not run_vals:
            run_idxs.append(i)
            run_vals.append(p)
            continue

        prev_p = run_vals[-1]

        # monotonic constraint (note: on remonte le temps, donc inversion)
        if mode == "lower_highs":
            # Dans le temps normal : p0 > p1 > p2...
            # Ici, en allant du plus récent vers l'ancien, on veut prev_p < p (l'ancien plus haut)
            ok = p > prev_p + (min_step_delta_atr_mult * atr)
        elif mode == "higher_lows":
            # Dans le temps normal : p0 < p1 < p2...
            # Ici, en allant du plus récent vers l'ancien, on veut prev_p > p (l'ancien plus bas)
            ok = p < prev_p - (min_step_delta_atr_mult * atr)
        else:
            ok = False

        if not ok:
            break

        run_idxs.append(i)
        run_vals.append(p)

        if len(run_idxs) >= max_steps:
            break

    if len(run_idxs) < min_steps:
        return None

    # run_idxs/run_vals sont en ordre (plus récent -> plus ancien). On remet chronologique.
    run_idxs = list(reversed(run_idxs))
    run_vals = list(reversed(run_vals))
    return run_idxs, run_vals


def _find_fake_break_away(
    *,
    candles: list[Any],
    start_index: int,
    direction: str,
    swing_level: float,
    atr: float,
    min_break_atr_mult: float,
    require_close: bool,
) -> tuple[Optional[int], Optional[float], Optional[float]]:
    """
    direction = "BULLISH" (zone demand) -> fake break AWAY = break UP
    direction = "BEARISH" (zone supply) -> fake break AWAY = break DOWN
    """
    if start_index >= len(candles):
        return None, None, None

    min_dist = min_break_atr_mult * atr

    for i in range(start_index, len(candles)):
        o = _c_get(candles[i], "open")
        h = _c_get(candles[i], "high")
        l = _c_get(candles[i], "low")
        cl = _c_get(candles[i], "close")

        if direction == "BULLISH":
            # break away = UP beyond swing high
            crossed = (cl > swing_level + min_dist) if require_close else (h > swing_level + min_dist)
        else:
            crossed = (cl < swing_level - min_dist) if require_close else (l < swing_level - min_dist)

        if crossed:
            return i, cl, swing_level

    return None, None, None


def _zone_touched(high: float, low: float, zone_top: float, zone_bot: float, mode: str) -> bool:
    # overlap = intersection des ranges
    if mode == "overlap":
        return not (high < zone_bot or low > zone_top)
    # penetration = au moins une partie du range dans la zone (équivalent ici)
    return not (high < zone_bot or low > zone_top)


def _penetration_pct_for_hit(
    *,
    high: float,
    low: float,
    zone_top: float,
    zone_bot: float,
    direction: str,
) -> float:
    """
    Calcule une profondeur de pénétration normalisée 0..1 (approx) :
    - DEMAND (direction BULLISH) : combien le low pénètre sous zone_top vers zone_bot
    - SUPPLY (direction BEARISH) : combien le high pénètre au-dessus zone_bot vers zone_top
    """
    height = max(1e-9, zone_top - zone_bot)
    if direction == "BULLISH":
        # penetration from top down
        pen = max(0.0, zone_top - low)
    else:
        # penetration from bot up
        pen = max(0.0, high - zone_bot)
    return _clip01(pen / height)


def _find_zone_hit_after(
    *,
    candles: list[Any],
    start_index: int,
    zone_top: float,
    zone_bot: float,
    direction: str,
    max_bars: int,
    touch_mode: str,
) -> tuple[Optional[int], float]:
    """
    Retourne (idx, penetration_pct) de la première bougie qui touche la zone.
    """
    end = min(len(candles) - 1, start_index + max_bars)
    best_pen = 0.0

    for i in range(start_index, end + 1):
        h = _c_get(candles[i], "high")
        l = _c_get(candles[i], "low")
        if not _zone_touched(h, l, zone_top, zone_bot, touch_mode):
            continue

        pen = _penetration_pct_for_hit(high=h, low=l, zone_top=zone_top, zone_bot=zone_bot, direction=direction)
        best_pen = max(best_pen, pen)
        return i, pen

    return None, best_pen
