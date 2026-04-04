"""
core/advanced_patterns/counter_attack.py — Counter Attack pattern (HLZ)
Pattern avancé : rejet violent depuis une zone opposée (Supply/Demand).

Idée (implémentation robuste & générique) :
- Le prix "attaque" une zone (impulsion directionnelle vers la zone)
- Une bougie de rejet (wick prononcé + clôture hors zone) apparaît
- Cela donne un signal de "contre-attaque" (reversal agressif depuis la zone)

Ce module est volontairement :
- Stateless
- Tolérant sur le type de bougies (objets avec attributs OHLC ou dict)
- Tolérant sur le type de zone (dict ou objet avec zone_top/zone_bot/zone_type)

Entrées :
- candles: List[CandleLike]
- zone: dict|object optionnel (zone_top, zone_bot, zone_type)

Sortie :
- CounterAttackResult (detected + direction + strength + meta)
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
    """Lecture tolérante d'un champ candle (attribut ou dict)."""
    if isinstance(c, dict):
        return float(c.get(key, default))
    return float(getattr(c, key, default))


def _z_get(z: Any, key: str, default: Any = None) -> Any:
    """Lecture tolérante d'un champ zone (attribut ou dict)."""
    if z is None:
        return default
    if isinstance(z, dict):
        return z.get(key, default)
    return getattr(z, key, default)


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class CounterAttackConfig:
    # Scan
    lookback: int = 30  # nb de bougies récentes à scanner

    # Impulsion ("attaque" de la zone)
    min_impulse_candles: int = 3         # nb bougies majoritairement directionnelles avant rejet
    min_impulse_body_pct: float = 0.6    # fraction min de bougies dans le sens de l'impulsion
    atr_period: int = 14
    min_attack_range_atr_mult: float = 0.8  # mouvement min (range net) vers zone, en ATR

    # Zone touch/proximity
    zone_touch_mode: str = "overlap"  # "overlap" | "penetration"
    require_close_outside_zone: bool = True

    # Rejection candle filters
    min_wick_to_body: float = 1.5     # wick dominant vs body (rejet violent)
    min_wick_to_range: float = 0.45   # wick dominant vs range total
    min_body_to_range: float = 0.15   # éviter doji trop faibles
    min_reject_size_atr_mult: float = 0.6  # taille du rejet (range) en ATR

    # Scoring weights (0..1)
    w_wick: float = 0.35
    w_close: float = 0.25
    w_impulse: float = 0.25
    w_size: float = 0.15


@dataclass
class CounterAttackResult:
    detected: bool = False
    direction: str = ""          # "BULLISH" | "BEARISH"
    strength: int = 0            # 0..100
    rejection_index: Optional[int] = None
    trigger_price: Optional[float] = None
    zone_type: Optional[str] = None
    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class CounterAttackDetector:
    """
    Détecteur Counter Attack.

    Convention direction :
    - Bullish counter-attack : rejet depuis DEMAND (wick bas + close hors zone vers le haut)
    - Bearish counter-attack : rejet depuis SUPPLY (wick haut + close hors zone vers le bas)

    Remarque :
    - Si zone_type est FLIPPY/HIDDEN, on garde la logique par "demand vs supply"
      en inférant depuis le label.
    """

    def __init__(self, config: Optional[CounterAttackConfig] = None) -> None:
        self.config = config or CounterAttackConfig()

    def detect(self, candles: list[Any], zone: Optional[Any] = None) -> CounterAttackResult:
        cfg = self.config

        if not candles or len(candles) < max(cfg.atr_period + 2, cfg.min_impulse_candles + 2):
            return CounterAttackResult(detected=False, details={"reason": "not_enough_candles"})

        if zone is None:
            return CounterAttackResult(detected=False, details={"reason": "zone_required"})

        zone_top = _z_get(zone, "zone_top")
        zone_bot = _z_get(zone, "zone_bot")
        zone_type = _z_get(zone, "zone_type") or _z_get(zone, "type") or _z_get(zone, "zoneType")

        if zone_top is None or zone_bot is None:
            return CounterAttackResult(detected=False, details={"reason": "zone_missing_bounds"})

        zone_top = float(zone_top)
        zone_bot = float(zone_bot)
        if zone_top < zone_bot:
            zone_top, zone_bot = zone_bot, zone_top

        zt = str(zone_type) if zone_type is not None else ""
        zt_u = zt.upper()

        is_demand = any(k in zt_u for k in ("DEMAND", "FLIPPY_D", "HIDDEN_D"))
        is_supply = any(k in zt_u for k in ("SUPPLY", "FLIPPY_S", "HIDDEN_S"))

        if not (is_demand or is_supply):
            # fallback : si inconnu, on tente les deux côtés via heuristique (close vs zone mid)
            # mais pour rester fiable, on marque comme inconnu.
            return CounterAttackResult(detected=False, details={"reason": "unknown_zone_type", "zone_type": zt})

        atr = _compute_atr(candles, period=cfg.atr_period)
        if atr <= 0:
            return CounterAttackResult(detected=False, details={"reason": "atr_invalid"})

        # scan des dernières bougies (du plus récent au plus ancien)
        start = max(0, len(candles) - cfg.lookback)
        candidates = range(len(candles) - 1, start - 1, -1)

        best: CounterAttackResult = CounterAttackResult(detected=False, zone_type=zt)
        best_score = 0

        for i in candidates:
            c = candles[i]
            o = _c_get(c, "open")
            h = _c_get(c, "high")
            l = _c_get(c, "low")
            cl = _c_get(c, "close")

            if h <= l:
                continue

            # 1) Touch zone ?
            touched = _zone_touched(
                high=h, low=l,
                zone_top=zone_top, zone_bot=zone_bot,
                mode=cfg.zone_touch_mode,
            )
            if not touched:
                continue

            # 2) Rejet directionnel attendu
            if is_demand:
                direction = "BULLISH"
                wick = _lower_wick(o, h, l, cl)
                opp_wick = _upper_wick(o, h, l, cl)
                close_outside = (cl >= zone_top) if cfg.require_close_outside_zone else True
                # éviter bougie "retournement" mais qui finit faible dans la zone
                if not close_outside:
                    continue
            else:
                direction = "BEARISH"
                wick = _upper_wick(o, h, l, cl)
                opp_wick = _lower_wick(o, h, l, cl)
                close_outside = (cl <= zone_bot) if cfg.require_close_outside_zone else True
                if not close_outside:
                    continue

            body = abs(cl - o)
            rng = h - l
            if rng <= 0:
                continue

            # 3) Filtre rejet (wick dominant, body non-null, taille)
            if body / rng < cfg.min_body_to_range:
                continue
            if body <= 0:
                continue

            wick_to_body = wick / body if body > 0 else 0.0
            wick_to_range = wick / rng

            if wick_to_body < cfg.min_wick_to_body:
                continue
            if wick_to_range < cfg.min_wick_to_range:
                continue
            if rng < cfg.min_reject_size_atr_mult * atr:
                continue

            # 4) Vérifier impulsion précédente vers la zone
            impulse_ok, impulse_score, impulse_details = _check_impulse_into_zone(
                candles=candles,
                reject_index=i,
                direction=direction,
                min_n=cfg.min_impulse_candles,
                min_body_pct=cfg.min_impulse_body_pct,
                atr=atr,
                min_range_atr_mult=cfg.min_attack_range_atr_mult,
            )
            if not impulse_ok:
                continue

            # 5) Scoring (0..100)
            wick_score = _clip01(
                0.5 * (wick_to_body / max(cfg.min_wick_to_body, 1e-9) - 1.0)
                + 0.5 * (wick_to_range / max(cfg.min_wick_to_range, 1e-9) - 1.0)
            )
            close_score = _close_outside_score(cl, zone_top, zone_bot, direction, atr)
            size_score = _clip01(rng / (cfg.min_reject_size_atr_mult * atr) - 1.0)

            score01 = (
                cfg.w_wick * wick_score
                + cfg.w_close * close_score
                + cfg.w_impulse * impulse_score
                + cfg.w_size * size_score
            )
            strength = int(round(100 * _clip01(score01)))

            if strength > best_score:
                best_score = strength
                best = CounterAttackResult(
                    detected=True,
                    direction=direction,
                    strength=strength,
                    rejection_index=i,
                    trigger_price=cl,
                    zone_type=zt,
                    details={
                        "zone_top": zone_top,
                        "zone_bot": zone_bot,
                        "rejection": {
                            "open": o,
                            "high": h,
                            "low": l,
                            "close": cl,
                            "range": rng,
                            "body": body,
                            "wick": wick,
                            "opp_wick": opp_wick,
                            "wick_to_body": round(wick_to_body, 3),
                            "wick_to_range": round(wick_to_range, 3),
                            "close_outside": close_outside,
                        },
                        "atr": round(atr, 8),
                        "scores": {
                            "wick": round(wick_score, 3),
                            "close": round(close_score, 3),
                            "impulse": round(impulse_score, 3),
                            "size": round(size_score, 3),
                        },
                        "impulse_details": impulse_details,
                    },
                )

        return best


# ═════════════════════════════════════════════════════════════════════════════=
# Internals
# ═════════════════════════════════════════════════════════════════════════════=

def _upper_wick(o: float, h: float, l: float, c: float) -> float:
    return max(0.0, h - max(o, c))


def _lower_wick(o: float, h: float, l: float, c: float) -> float:
    return max(0.0, min(o, c) - l)


def _zone_touched(*, high: float, low: float, zone_top: float, zone_bot: float, mode: str) -> bool:
    """
    overlap: la bougie chevauche la zone (range intersects)
    penetration: exige une pénétration minimale (low <= top pour demand / high >= bot pour supply)
    Ici on utilise une version générique : intersection stricte.
    """
    if mode == "penetration":
        # penetration = au moins une partie du range est dans la zone
        return not (high < zone_bot or low > zone_top)
    # overlap par défaut (identique ici)
    return not (high < zone_bot or low > zone_top)


def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _compute_atr(candles: list[Any], period: int = 14) -> float:
    """
    ATR simple basé sur True Range (Wilder-like average simple).
    Tolérant dict/obj.
    """
    if len(candles) < period + 2:
        return 0.0

    trs: list[float] = []
    # on calcule TR sur les 'period' dernières bougies fermées
    start = len(candles) - period - 1
    for i in range(start + 1, len(candles)):
        cur = candles[i]
        prev = candles[i - 1]
        h = _c_get(cur, "high")
        l = _c_get(cur, "low")
        prev_close = _c_get(prev, "close")
        tr = max(h - l, abs(h - prev_close), abs(l - prev_close))
        if tr > 0:
            trs.append(tr)

    if not trs:
        return 0.0
    return sum(trs) / len(trs)


def _check_impulse_into_zone(
    *,
    candles: list[Any],
    reject_index: int,
    direction: str,
    min_n: int,
    min_body_pct: float,
    atr: float,
    min_range_atr_mult: float,
) -> tuple[bool, float, dict[str, Any]]:
    """
    Vérifie qu'avant la bougie de rejet, il y a une impulsion cohérente vers la zone.
    - direction BULLISH => impulsion précédente BEARISH (prix descendait)
    - direction BEARISH => impulsion précédente BULLISH (prix montait)
    Retourne (ok, impulse_score01, details)
    """
    if reject_index - min_n < 1:
        return False, 0.0, {"reason": "not_enough_history_for_impulse"}

    window = candles[reject_index - min_n : reject_index]

    # comptage bougies directionnelles
    same_dir = 0
    total = len(window)
    if total <= 0:
        return False, 0.0, {"reason": "empty_window"}

    # on veut un mouvement net vers la zone
    o0 = _c_get(window[0], "open")
    cN = _c_get(window[-1], "close")

    if direction == "BULLISH":
        # impulsion vers le bas => close < open majoritairement
        for c in window:
            if _c_get(c, "close") < _c_get(c, "open"):
                same_dir += 1
        net_move = o0 - cN  # positif si baisse
        ok_move = net_move >= min_range_atr_mult * atr
    else:
        for c in window:
            if _c_get(c, "close") > _c_get(c, "open"):
                same_dir += 1
        net_move = cN - o0  # positif si hausse
        ok_move = net_move >= min_range_atr_mult * atr

    frac = same_dir / total
    ok_frac = frac >= min_body_pct

    if not (ok_frac and ok_move):
        return False, 0.0, {
            "direction": direction,
            "frac_directional": round(frac, 3),
            "net_move": net_move,
            "min_required": min_range_atr_mult * atr,
            "ok_frac": ok_frac,
            "ok_move": ok_move,
        }

    # impulse score : combine fraction + amplitude
    frac_score = _clip01((frac - min_body_pct) / max(1e-9, (1.0 - min_body_pct)))
    amp_score = _clip01(net_move / max(1e-9, (min_range_atr_mult * atr)) - 1.0)
    score01 = 0.6 * frac_score + 0.4 * amp_score

    return True, _clip01(score01), {
        "direction": direction,
        "same_dir": same_dir,
        "total": total,
        "frac_directional": round(frac, 3),
        "net_move": net_move,
        "atr": atr,
    }


def _close_outside_score(close: float, zone_top: float, zone_bot: float, direction: str, atr: float) -> float:
    """
    Score basé sur la distance de clôture hors zone (plus c'est loin, plus c'est fort),
    normalisé à ~1 ATR.
    """
    if atr <= 0:
        return 0.0

    if direction == "BULLISH":
        # close au-dessus du top
        dist = max(0.0, close - zone_top)
    else:
        dist = max(0.0, zone_bot - close)

    return _clip01(dist / atr)  # 1 ATR => score 1