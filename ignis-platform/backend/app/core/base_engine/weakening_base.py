"""
core/base_engine/weakening_base.py — Weakening Base (WB) detector (HLZ)

WB = base fragilisée par retours multiples / pénétration croissante / réactions de plus en plus faibles.

Objectif :
- Analyser ce qui se passe APRÈS la formation de la base (post base_end_index)
- Détecter si la base perd sa validité HLZ ("freshness" qui se dégrade)
- Fournir :
  • touches (nombre de retours distincts)
  • pénétration moyenne / max dans la base
  • réaction (bounce) après chaque touch
  • un score de "weakening" (0..100) + flag weakened

Conventions :
- Si la base a un départ bullish (RBR/DBR) => base assimilée à DEMAND (support)
- Si départ bearish (DBD/RBD) => base assimilée à SUPPLY (resistance)

Design :
- Stateless
- Tolérant (base dict/obj, candles dict/obj)
- Ne dépend pas de pandas/numpy
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

import structlog

from app import BaseType

log = structlog.get_logger(__name__)


# ═════════════════════════════════════════════════════════════════════════════=
# Candle / Base helpers (tolérant)
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


def _b_get(b: Any, key: str, default: Any = None) -> Any:
    if b is None:
        return default
    if isinstance(b, dict):
        return b.get(key, default)
    return getattr(b, key, default)


def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _compute_atr(candles: list[Any], period: int = 14) -> float:
    """ATR simple (TR moyen) sur les dernières bougies."""
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


def _intersects(high: float, low: float, top: float, bot: float) -> bool:
    return not (high < bot or low > top)


def _departure_direction(base_type: str) -> str:
    bt = (base_type or "").upper()
    if bt in (BaseType.RBR, BaseType.DBR):
        return "BULLISH"
    if bt in (BaseType.DBD, BaseType.RBD):
        return "BEARISH"
    return ""


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class WeakeningBaseConfig:
    atr_period: int = 14

    # Scan post-base
    lookahead: int = 350                    # nb max de bougies après base_end pour analyser
    ignore_first_bars_after_base: int = 2   # ignore les bougies de départ immédiates

    # Touch definition
    touch_mode: str = "overlap"             # "overlap" | "close_inside"
    min_separation_bars: int = 2            # séparation mini pour compter 2 touches distinctes (clusters)

    # Penetration (normalisée)
    # demand : penetration = (base_top - low) / height
    # supply : penetration = (high - base_bot) / height
    min_penetration_to_count: float = 0.0   # 0..1 (0 = simple overlap)
    invalidation_buffer_atr_mult: float = 0.05  # close au-delà de base_bot/base_top => base "cassée"

    # Reaction strength after touch
    reaction_window: int = 6                # nb de bougies post touch pour mesurer réaction
    min_reaction_atr_mult: float = 0.25     # réaction min (sinon touch considéré "mou")

    # Weakening rules
    weaken_if_touches_gte: int = 3
    weaken_if_max_penetration_gte: float = 0.75  # 75% de la base pénétrée
    weaken_if_reaction_decay: bool = True        # réactions décroissantes

    # Scoring weights -> weakness_score (0..100, plus haut = plus faible)
    w_touches: float = 0.35
    w_penetration: float = 0.30
    w_reaction: float = 0.25
    w_decay: float = 0.10


@dataclass
class WeakeningBaseResult:
    weakened: bool = False
    invalidated: bool = False

    weakness_score: int = 0            # 0..100 (0 = base fraîche, 100 = base très faible)
    touches: int = 0

    base_type: Optional[str] = None
    side: str = ""                     # "DEMAND" | "SUPPLY"
    atr: Optional[float] = None

    base_start_index: Optional[int] = None
    base_end_index: Optional[int] = None
    base_top: Optional[float] = None
    base_bot: Optional[float] = None

    first_touch_index: Optional[int] = None
    last_touch_index: Optional[int] = None

    avg_penetration: float = 0.0
    max_penetration: float = 0.0
    reactions_atr: list[float] = field(default_factory=list)  # réaction (en ATR) par touch

    details: dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════=
# Detector
# ═════════════════════════════════════════════════════════════════════════════=

class WeakeningBaseDetector:
    """
    Détecte la fragilisation d'une base.

    Entrée base attendue (dict/obj) :
    - base_type (RBR/DBD/RBD/DBR)
    - base_start_index, base_end_index
    - base_top, base_bot
    """

    def __init__(self, config: Optional[WeakeningBaseConfig] = None) -> None:
        self.config = config or WeakeningBaseConfig()

    def detect(self, candles: list[Any], base: Any) -> WeakeningBaseResult:
        cfg = self.config

        if not candles or len(candles) < cfg.atr_period + 10:
            return WeakeningBaseResult(weakened=False, weakness_score=0, details={"reason": "not_enough_candles"})

        base_type = _b_get(base, "base_type", "") or _b_get(base, "type", "")
        b_start = _b_get(base, "base_start_index")
        b_end = _b_get(base, "base_end_index")
        b_top = _b_get(base, "base_top")
        b_bot = _b_get(base, "base_bot")

        if b_start is None or b_end is None or b_top is None or b_bot is None:
            return WeakeningBaseResult(
                base_type=str(base_type) if base_type else None,
                weakened=False,
                weakness_score=0,
                details={"reason": "base_missing_fields"},
            )

        b_start = int(b_start)
        b_end = int(b_end)
        b_top = float(b_top)
        b_bot = float(b_bot)
        if b_top < b_bot:
            b_top, b_bot = b_bot, b_top

        if b_end < 0 or b_end >= len(candles) - 1 or b_end <= b_start:
            return WeakeningBaseResult(
                base_type=str(base_type) if base_type else None,
                weakened=False,
                weakness_score=0,
                details={"reason": "base_indices_invalid", "b_start": b_start, "b_end": b_end},
            )

        atr = _compute_atr(candles, period=cfg.atr_period)
        if atr <= 0:
            return WeakeningBaseResult(
                base_type=str(base_type) if base_type else None,
                weakened=False,
                weakness_score=0,
                details={"reason": "atr_invalid"},
            )

        dep_dir = _departure_direction(str(base_type))
        if dep_dir == "BULLISH":
            side = "DEMAND"
        elif dep_dir == "BEARISH":
            side = "SUPPLY"
        else:
            # fallback : si inconnu, on ne sait pas comment mesurer pénétration/réaction
            return WeakeningBaseResult(
                base_type=str(base_type) if base_type else None,
                weakened=False,
                weakness_score=0,
                atr=float(atr),
                details={"reason": "unknown_base_type_direction", "base_type": str(base_type)},
            )

        height = max(1e-12, b_top - b_bot)

        scan_start = min(len(candles) - 1, b_end + 1 + cfg.ignore_first_bars_after_base)
        scan_end = min(len(candles) - 1, b_end + cfg.lookahead)
        if scan_start >= scan_end:
            return WeakeningBaseResult(
                base_type=str(base_type),
                weakened=False,
                weakness_score=0,
                side=side,
                atr=float(atr),
                base_start_index=b_start,
                base_end_index=b_end,
                base_top=b_top,
                base_bot=b_bot,
                details={"reason": "no_post_base_data"},
            )

        touches = _extract_touches(
            candles=candles,
            start=scan_start,
            end=scan_end,
            base_top=b_top,
            base_bot=b_bot,
            touch_mode=cfg.touch_mode,
            min_separation_bars=cfg.min_separation_bars,
        )

        # Invalidation detection (close through base)
        invalidated, inv_meta = _check_invalidation(
            candles=candles,
            touches=touches,
            base_top=b_top,
            base_bot=b_bot,
            side=side,
            atr=atr,
            buffer_mult=cfg.invalidation_buffer_atr_mult,
        )

        # Compute penetrations + reactions
        penetrations: list[float] = []
        reactions_atr: list[float] = []
        touch_meta: list[dict[str, Any]] = []

        for t in touches:
            pen = _touch_penetration(
                candles=candles,
                touch=t,
                base_top=b_top,
                base_bot=b_bot,
                side=side,
                height=height,
            )
            if pen < cfg.min_penetration_to_count:
                # On garde quand même la touch dans l'historique (c'est un retest), mais
                # pour le weakening score, on considère penetration minimale (ou 0).
                pen_for_score = 0.0
            else:
                pen_for_score = pen

            rx = _touch_reaction_atr(
                candles=candles,
                touch=t,
                base_top=b_top,
                base_bot=b_bot,
                side=side,
                atr=atr,
                reaction_window=cfg.reaction_window,
            )

            penetrations.append(pen_for_score)
            reactions_atr.append(rx)

            touch_meta.append({
                "touch_start": t["start"],
                "touch_end": t["end"],
                "penetration_pct": round(pen, 3),
                "reaction_atr": round(rx, 3),
            })

        touch_count = len(touches)
        avg_pen = (sum(penetrations) / touch_count) if touch_count else 0.0
        max_pen = max(penetrations) if penetrations else 0.0

        # Reaction weakness: if many reactions are weak (< min_reaction_atr_mult)
        weak_reactions = sum(1 for r in reactions_atr if r < cfg.min_reaction_atr_mult)
        reaction_weak_ratio = (weak_reactions / touch_count) if touch_count else 0.0

        # Decay detection: reactions decreasing over touches
        decay_score01, decay_meta = _reaction_decay_score(reactions_atr)

        # ── Weakness scoring (0..100, plus haut = plus faible) ────────────────
        touches_score01 = _clip01(touch_count / max(1, cfg.weaken_if_touches_gte))
        penetration_score01 = _clip01(max_pen / max(1e-9, cfg.weaken_if_max_penetration_gte)) if cfg.weaken_if_max_penetration_gte > 0 else _clip01(max_pen)

        reaction_score01 = _clip01(reaction_weak_ratio)  # 0..1 (1 = réactions souvent faibles)
        decay_component01 = decay_score01 if cfg.weaken_if_reaction_decay else 0.0

        weakness01 = (
            cfg.w_touches * touches_score01
            + cfg.w_penetration * penetration_score01
            + cfg.w_reaction * reaction_score01
            + cfg.w_decay * decay_component01
        )
        weakness_score = int(round(100 * _clip01(weakness01)))

        # ── Decision weakened flag ────────────────────────────────────────────
        weakened = (
            (touch_count >= cfg.weaken_if_touches_gte)
            or (max_pen >= cfg.weaken_if_max_penetration_gte)
            or (cfg.weaken_if_reaction_decay and decay_score01 >= 0.60)
            or (reaction_weak_ratio >= 0.70 and touch_count >= 2)
        )

        first_touch = touches[0]["start"] if touches else None
        last_touch = touches[-1]["end"] if touches else None

        return WeakeningBaseResult(
            weakened=bool(weakened),
            invalidated=bool(invalidated),
            weakness_score=weakness_score,
            touches=touch_count,
            base_type=str(base_type) if base_type else None,
            side=side,
            atr=float(atr),
            base_start_index=b_start,
            base_end_index=b_end,
            base_top=b_top,
            base_bot=b_bot,
            first_touch_index=first_touch,
            last_touch_index=last_touch,
            avg_penetration=float(round(avg_pen, 4)),
            max_penetration=float(round(max_pen, 4)),
            reactions_atr=[float(round(r, 4)) for r in reactions_atr],
            details={
                "scan": {"start": scan_start, "end": scan_end},
                "touches": touch_meta,
                "invalidation": inv_meta,
                "reaction_decay": decay_meta,
                "components": {
                    "touches_score01": round(touches_score01, 3),
                    "penetration_score01": round(penetration_score01, 3),
                    "reaction_score01": round(reaction_score01, 3),
                    "decay_score01": round(decay_component01, 3),
                    "weakness01": round(_clip01(weakness01), 3),
                },
            },
        )


# ═════════════════════════════════════════════════════════════════════════════=
# Internals
# ═════════════════════════════════════════════════════════════════════════════=

def _extract_touches(
    *,
    candles: list[Any],
    start: int,
    end: int,
    base_top: float,
    base_bot: float,
    touch_mode: str,
    min_separation_bars: int,
) -> list[dict[str, int]]:
    """
    Retourne une liste de touches (clusters) :
      [{"start": i0, "end": i1}, ...]
    """
    touches: list[dict[str, int]] = []
    in_touch = False
    touch_start = -1
    last_touch_end = -10_000

    for i in range(start, end + 1):
        hi = _c_get(candles[i], "high")
        lo = _c_get(candles[i], "low")
        cl = _c_get(candles[i], "close")

        if touch_mode == "close_inside":
            hit = (base_bot <= cl <= base_top)
        else:
            hit = _intersects(hi, lo, base_top, base_bot)

        if hit and not in_touch:
            # séparation mini pour compter un nouveau touch
            if i - last_touch_end <= min_separation_bars:
                in_touch = True
                # on "colle" au touch précédent si trop proche
                if touches:
                    touches[-1]["end"] = i
                else:
                    touch_start = i
                    touches.append({"start": touch_start, "end": i})
            else:
                in_touch = True
                touch_start = i
                touches.append({"start": i, "end": i})

        elif hit and in_touch:
            touches[-1]["end"] = i

        elif not hit and in_touch:
            in_touch = False
            last_touch_end = touches[-1]["end"]

    return touches


def _touch_penetration(
    *,
    candles: list[Any],
    touch: dict[str, int],
    base_top: float,
    base_bot: float,
    side: str,
    height: float,
) -> float:
    """
    Pénétration normalisée 0..1 dans la base.
    DEMAND : profondeur depuis top vers bot (via min low du cluster)
    SUPPLY : profondeur depuis bot vers top (via max high du cluster)
    """
    s, e = touch["start"], touch["end"]
    win = candles[s : e + 1]
    if not win:
        return 0.0

    if side == "DEMAND":
        min_low = min(_c_get(x, "low") for x in win)
        # si min_low est au-dessus du base_top => pas de pénétration
        pen = max(0.0, base_top - min_low) / max(1e-12, height)
    else:
        max_high = max(_c_get(x, "high") for x in win)
        pen = max(0.0, max_high - base_bot) / max(1e-12, height)

    return _clip01(pen)


def _touch_reaction_atr(
    *,
    candles: list[Any],
    touch: dict[str, int],
    base_top: float,
    base_bot: float,
    side: str,
    atr: float,
    reaction_window: int,
) -> float:
    """
    Mesure la réaction (move away) après la fin du touch (cluster).
    Retour en ATR.
    """
    if atr <= 0:
        return 0.0

    end_idx = touch["end"]
    start = end_idx + 1
    end = min(len(candles) - 1, start + max(1, reaction_window) - 1)
    if start > end:
        return 0.0

    win = candles[start : end + 1]
    if not win:
        return 0.0

    if side == "DEMAND":
        max_high = max(_c_get(x, "high") for x in win)
        move = max(0.0, max_high - base_top)
    else:
        min_low = min(_c_get(x, "low") for x in win)
        move = max(0.0, base_bot - min_low)

    return move / atr


def _reaction_decay_score(reactions_atr: list[float]) -> tuple[float, dict[str, Any]]:
    """
    Détecte une décroissance des réactions (plus faible au fil des touches).
    Retourne (score01, meta).
    score01 ~ 0 : pas de decay ; ~1 : decay fort.
    """
    if len(reactions_atr) < 3:
        return 0.0, {"enough_points": False, "score01": 0.0}

    first = reactions_atr[0]
    last = reactions_atr[-1]
    if first <= 1e-9:
        return 0.0, {"enough_points": True, "score01": 0.0, "reason": "first_reaction_zero"}

    # decay ratio
    ratio = _clip01(1.0 - (last / first))  # si last << first => proche 1
    # monotonicity proxy: count decreases
    dec = 0
    for i in range(1, len(reactions_atr)):
        if reactions_atr[i] < reactions_atr[i - 1]:
            dec += 1
    mono = dec / (len(reactions_atr) - 1)

    score01 = _clip01(0.65 * ratio + 0.35 * mono)
    return score01, {
        "enough_points": True,
        "first": round(first, 4),
        "last": round(last, 4),
        "ratio": round(ratio, 3),
        "monotonicity": round(mono, 3),
        "score01": round(score01, 3),
        "series": [round(x, 4) for x in reactions_atr],
    }


def _check_invalidation(
    *,
    candles: list[Any],
    touches: list[dict[str, int]],
    base_top: float,
    base_bot: float,
    side: str,
    atr: float,
    buffer_mult: float,
) -> tuple[bool, dict[str, Any]]:
    """
    Invalidation "hard" :
    - DEMAND invalidée si close < base_bot - buffer*ATR
    - SUPPLY invalidée si close > base_top + buffer*ATR
    On check à partir du premier touch (sinon trop strict).
    """
    if not touches or atr <= 0:
        return False, {"checked": False}

    start = touches[0]["start"]
    buf = buffer_mult * atr
    invalid_idx = None

    for i in range(start, len(candles)):
        cl = _c_get(candles[i], "close")
        if side == "DEMAND":
            if cl < (base_bot - buf):
                invalid_idx = i
                break
        else:
            if cl > (base_top + buf):
                invalid_idx = i
                break

    return (invalid_idx is not None), {
        "checked": True,
        "buffer": buf,
        "invalid_index": invalid_idx,
        "rule": "close_through_base",
    }
