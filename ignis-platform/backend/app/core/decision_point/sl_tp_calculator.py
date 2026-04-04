"""
core/decision_point/sl_tp_calculator.py — Calculateur SL/TP & RR (HLZ)

Objectif :
- Calculer des niveaux de trade cohérents à partir d'une zone S&D (SGB/SDE),
  et éventuellement de DP/KeyLevels.
- Retourner : entry, stop_loss, take_profit, rr, et des métadonnées.

Principes (génériques HLZ) :
- DEMAND (bullish) :
    entry ~ proximal (zone_top) par défaut
    SL   ~ sous distal (zone_bot) + buffer
    TP   ~ nearest KeyLevel au-dessus, sinon RR target
- SUPPLY (bearish) :
    entry ~ proximal (zone_bot)
    SL   ~ au-dessus distal (zone_top) + buffer
    TP   ~ nearest KeyLevel en dessous, sinon RR target

Design :
- Stateless
- Tolérant : candles dict/obj, zone/dp/key_levels dict/obj
- Ne fait pas de "conseil" : calcule uniquement des niveaux.

Entrées attendues (souples) :
- zone: {zone_top, zone_bot, zone_type?} ou objet avec attributs
- key_levels: [{"level": float, "type": str, "strength": int?}, ...] (optionnel)
- dp: dict/obj optionnel (dp.level, dp.dp_type, dp.direction)

Sortie :
- SLTPResult (valid + rr_ok + rr + details)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable, Literal

import structlog

log = structlog.get_logger(__name__)

EntryPolicy = Literal["PROXIMAL", "DISTAL", "MID"]
TPMode = Literal["KEY_LEVEL", "RR_ONLY", "DP_LEVEL", "BEST_AVAILABLE"]


# ═════════════════════════════════════════════════════════════════════════════=
# Helpers (tolérant dict/obj)
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


def _o_get(o: Any, key: str, default: Any = None) -> Any:
    if o is None:
        return default
    if isinstance(o, dict):
        return o.get(key, default)
    return getattr(o, key, default)


def _clip01(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


def _pct_distance(a: float, b: float) -> float:
    if b == 0:
        return 999.0
    return abs(a - b) / abs(b)


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


def _infer_direction_from_zone(zone: Any) -> Optional[str]:
    zt = str(_o_get(zone, "zone_type", "") or _o_get(zone, "type", "") or _o_get(zone, "zoneType", "")).upper()
    if any(k in zt for k in ("DEMAND", "FLIPPY_D", "HIDDEN_D")):
        return "BULLISH"
    if any(k in zt for k in ("SUPPLY", "FLIPPY_S", "HIDDEN_S")):
        return "BEARISH"
    return None


def _normalize_zone_bounds(zone_top: float, zone_bot: float) -> tuple[float, float]:
    zt = float(zone_top)
    zb = float(zone_bot)
    return (zt, zb) if zt >= zb else (zb, zt)


def _rr(entry: float, sl: float, tp: float) -> float:
    risk = abs(entry - sl)
    if risk <= 0:
        return 0.0
    reward = abs(tp - entry)
    return reward / risk


# ═════════════════════════════════════════════════════════════════════════════=
# Config / Result
# ═════════════════════════════════════════════════════════════════════════════=

@dataclass(frozen=True)
class SLTPConfig:
    atr_period: int = 14

    # Entry selection within zone
    entry_policy: EntryPolicy = "PROXIMAL"

    # SL buffers
    sl_buffer_atr_mult: float = 0.15            # buffer au-delà du distal (en ATR)
    sl_buffer_pct: float = 0.0010               # fallback si ATR=0 (0.10%)

    # TP selection
    tp_mode: TPMode = "BEST_AVAILABLE"
    rr_target: float = 3.0                      # utilisé si TP en mode RR_ONLY ou fallback
    rr_min: float = 2.0

    # TP buffers (éviter TP trop proche du KL/DP)
    tp_buffer_atr_mult: float = 0.00            # ex: 0.05*ATR pour "front-run" si voulu

    # Guard rails
    min_risk_atr_mult: float = 0.10             # si risk < X*ATR -> trop serré (option)
    max_rr_cap: float = 15.0                    # cap pour éviter valeurs absurdes

    # If key_levels exist: consider only levels not too close to entry
    min_tp_distance_atr_mult: float = 0.25
    min_tp_distance_pct: float = 0.0010

    # Prefer strong key levels first (if strength provided)
    prefer_strong_key_levels: bool = True


@dataclass
class SLTPResult:
    valid: bool = False
    rr_ok: bool = False

    direction: str = ""                     # "BULLISH" | "BEARISH"
    method: str = ""                        # "KEY_LEVEL" | "RR" | "DP_LEVEL" | "FALLBACK"

    entry: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    rr: float = 0.0

    # Useful extras
    risk: Optional[float] = None
    reward: Optional[float] = None

    zone_top: Optional[float] = None
    zone_bot: Optional[float] = None
    atr: Optional[float] = None

    candidates: list[dict[str, Any]] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "rr_ok": self.rr_ok,
            "direction": self.direction,
            "method": self.method,
            "entry": self.entry,
            "stop_loss": self.stop_loss,
            "take_profit": self.take_profit,
            "rr": round(self.rr, 4),
            "risk": self.risk,
            "reward": self.reward,
            "zone_top": self.zone_top,
            "zone_bot": self.zone_bot,
            "atr": self.atr,
            "candidates": self.candidates,
            "details": self.details,
        }


# ═════════════════════════════════════════════════════════════════════════════=
# Calculator
# ═════════════════════════════════════════════════════════════════════════════=

class SLTPCalculator:
    """
    Calculateur SL/TP.

    API :
        calc = SLTPCalculator()
        res = calc.calculate(candles, zone=zone, key_levels=kls, dp=dp)
    """

    def __init__(self, config: Optional[SLTPConfig] = None) -> None:
        self.config = config or SLTPConfig()

    def calculate(
        self,
        candles: list[Any],
        *,
        zone: Any,
        direction_hint: Optional[str] = None,
        key_levels: Optional[list[Any]] = None,
        dp: Optional[Any] = None,
        current_price: Optional[float] = None,
    ) -> SLTPResult:
        cfg = self.config

        if zone is None:
            return SLTPResult(valid=False, details={"reason": "zone_required"})

        zone_top = _o_get(zone, "zone_top")
        zone_bot = _o_get(zone, "zone_bot")
        if zone_top is None or zone_bot is None:
            return SLTPResult(valid=False, details={"reason": "zone_missing_bounds"})

        zt, zb = _normalize_zone_bounds(float(zone_top), float(zone_bot))

        # direction
        direction = _infer_direction_from_zone(zone)
        if not direction and direction_hint:
            dh = direction_hint.upper().strip()
            if dh in ("BULLISH", "BEARISH"):
                direction = dh
        if not direction and dp is not None:
            dd = str(_o_get(dp, "direction", "") or "").upper()
            if dd in ("BULLISH", "UP"):
                direction = "BULLISH"
            elif dd in ("BEARISH", "DOWN"):
                direction = "BEARISH"

        if not direction:
            return SLTPResult(valid=False, zone_top=zt, zone_bot=zb, details={"reason": "direction_unknown"})

        # ATR
        atr = _compute_atr(candles, period=cfg.atr_period) if candles else 0.0
        price = float(current_price) if current_price is not None else (_c_get(candles[-1], "close") if candles else 0.0)

        # Entry by policy
        entry = self._select_entry(zt, zb, direction=direction, policy=cfg.entry_policy)

        # SL (distal + buffer)
        sl = self._compute_sl(zt, zb, direction=direction, atr=atr, cfg=cfg)

        # guard: sl must be beyond entry
        if direction == "BULLISH" and sl >= entry:
            return SLTPResult(valid=False, direction=direction, zone_top=zt, zone_bot=zb, atr=atr,
                              details={"reason": "sl_not_below_entry", "entry": entry, "sl": sl})
        if direction == "BEARISH" and sl <= entry:
            return SLTPResult(valid=False, direction=direction, zone_top=zt, zone_bot=zb, atr=atr,
                              details={"reason": "sl_not_above_entry", "entry": entry, "sl": sl})

        risk = abs(entry - sl)
        if atr > 0 and risk < cfg.min_risk_atr_mult * atr:
            # pas forcément invalide, mais on le note
            risk_note = {"warning": "risk_too_small_vs_atr", "risk": risk, "atr": atr}
        else:
            risk_note = {}

        # TP candidates
        candidates: list[dict[str, Any]] = []

        # 1) From DP level (optional)
        dp_level = None
        if dp is not None:
            try:
                dp_level = float(_o_get(dp, "level", None) or _o_get(dp, "dp_level", None))
            except Exception:
                dp_level = None
        if dp_level and dp_level > 0:
            tp = self._tp_from_dp(entry, direction, dp_level, atr, cfg)
            if tp is not None:
                candidates.append(self._candidate("DP_LEVEL", entry, sl, tp, atr, extra={"dp_level": dp_level}))

        # 2) From Key Levels (optional)
        if key_levels:
            tp_kl = self._tp_from_key_levels(entry, direction, key_levels, atr, cfg)
            if tp_kl is not None:
                candidates.append(tp_kl)

        # 3) RR target fallback
        tp_rr = self._tp_from_rr(entry, sl, direction, cfg.rr_target)
        candidates.append(self._candidate("RR", entry, sl, tp_rr, atr, extra={"rr_target": cfg.rr_target}))

        # Choose best candidate according to tp_mode
        chosen = self._choose_candidate(candidates, cfg.tp_mode)
        if chosen is None:
            return SLTPResult(valid=False, direction=direction, zone_top=zt, zone_bot=zb, atr=atr,
                              details={"reason": "no_tp_candidate"})

        method = chosen["method"]
        tp = float(chosen["tp"])
        rr_val = float(chosen["rr"])
        if rr_val > cfg.max_rr_cap:
            rr_val = cfg.max_rr_cap

        reward = abs(tp - entry)
        rr_ok = rr_val >= cfg.rr_min

        return SLTPResult(
            valid=True,
            rr_ok=rr_ok,
            direction=direction,
            method=method,
            entry=float(entry),
            stop_loss=float(sl),
            take_profit=float(tp),
            rr=rr_val,
            risk=float(risk),
            reward=float(reward),
            zone_top=float(zt),
            zone_bot=float(zb),
            atr=float(atr) if atr else 0.0,
            candidates=candidates,
            details={
                "price": price,
                "risk_note": risk_note,
                "config": {
                    "entry_policy": cfg.entry_policy,
                    "tp_mode": cfg.tp_mode,
                    "rr_target": cfg.rr_target,
                    "rr_min": cfg.rr_min,
                },
            },
        )

    # ──────────────────────────────────────────────────────────────────────
    # internals
    # ──────────────────────────────────────────────────────────────────────

    @staticmethod
    def _select_entry(zone_top: float, zone_bot: float, *, direction: str, policy: EntryPolicy) -> float:
        if policy == "MID":
            return (zone_top + zone_bot) / 2.0

        if direction == "BULLISH":
            # proximal = top (plus proche du prix en approche), distal = bot
            return zone_top if policy == "PROXIMAL" else zone_bot

        # bearish
        return zone_bot if policy == "PROXIMAL" else zone_top

    @staticmethod
    def _compute_sl(zone_top: float, zone_bot: float, *, direction: str, atr: float, cfg: SLTPConfig) -> float:
        if atr and atr > 0:
            buf = cfg.sl_buffer_atr_mult * atr
        else:
            # fallback % du prix (distal)
            distal = zone_bot if direction == "BULLISH" else zone_top
            buf = cfg.sl_buffer_pct * distal

        if direction == "BULLISH":
            return zone_bot - buf
        return zone_top + buf

    @staticmethod
    def _tp_from_rr(entry: float, sl: float, direction: str, rr_target: float) -> float:
        risk = abs(entry - sl)
        if direction == "BULLISH":
            return entry + rr_target * risk
        return entry - rr_target * risk

    @staticmethod
    def _tp_from_dp(entry: float, direction: str, dp_level: float, atr: float, cfg: SLTPConfig) -> Optional[float]:
        """
        Utilise le dp_level comme TP si il est du bon côté et pas trop proche.
        """
        buf = (cfg.tp_buffer_atr_mult * atr) if (atr and atr > 0) else 0.0

        if direction == "BULLISH":
            if dp_level <= entry:
                return None
            return max(entry, dp_level - buf)
        else:
            if dp_level >= entry:
                return None
            return min(entry, dp_level + buf)

    def _tp_from_key_levels(
        self,
        entry: float,
        direction: str,
        key_levels: list[Any],
        atr: float,
        cfg: SLTPConfig,
    ) -> Optional[dict[str, Any]]:
        """
        Choisit le KeyLevel le plus logique comme TP (nearest in profit direction).
        On filtre ceux trop proches.
        """
        buf = (cfg.tp_buffer_atr_mult * atr) if (atr and atr > 0) else 0.0

        # distance min to accept
        min_dist = (cfg.min_tp_distance_atr_mult * atr) if (atr and atr > 0) else (cfg.min_tp_distance_pct * entry)

        candidates: list[tuple[float, Any]] = []
        for kl in key_levels:
            lvl = _o_get(kl, "level", None) or _o_get(kl, "price", None)
            if lvl is None:
                continue
            try:
                lvl = float(lvl)
            except Exception:
                continue
            if lvl <= 0:
                continue

            if direction == "BULLISH":
                if lvl <= entry + min_dist:
                    continue
                candidates.append((lvl, kl))
            else:
                if lvl >= entry - min_dist:
                    continue
                candidates.append((lvl, kl))

        if not candidates:
            return None

        # sort by profit-direction proximity
        if direction == "BULLISH":
            candidates.sort(key=lambda x: x[0])  # nearest above
        else:
            candidates.sort(key=lambda x: x[0], reverse=True)  # nearest below

        # if prefer strong levels, reorder by (strength desc) within a small band
        if cfg.prefer_strong_key_levels:
            # take top N nearest then choose strongest among them
            topN = candidates[:5]
            topN.sort(key=lambda x: int(_o_get(x[1], "strength", 0) or 0), reverse=True)
            lvl, kl = topN[0]
        else:
            lvl, kl = candidates[0]

        tp = (lvl - buf) if direction == "BULLISH" else (lvl + buf)

        # Build candidate dict
        # We keep the chosen key level in extra
        return self._candidate(
            "KEY_LEVEL",
            entry=entry,
            sl=None,  # filled by caller with correct SL
            tp=tp,
            atr=atr,
            extra={
                "key_level": {
                    "level": lvl,
                    "type": _o_get(kl, "type", _o_get(kl, "kl_type", "KEY_LEVEL")),
                    "strength": _o_get(kl, "strength", None),
                }
            },
            needs_sl=True,
        )

    @staticmethod
    def _candidate(
        method: str,
        entry: float,
        sl: Optional[float],
        tp: float,
        atr: float,
        extra: Optional[dict[str, Any]] = None,
        *,
        needs_sl: bool = False,
    ) -> dict[str, Any]:
        c: dict[str, Any] = {"method": method, "entry": float(entry), "tp": float(tp)}
        if extra:
            c.update(extra)
        if needs_sl:
            c["_needs_sl"] = True
        if sl is not None:
            c["sl"] = float(sl)
            c["rr"] = float(_rr(entry, sl, tp))
            c["risk"] = float(abs(entry - sl))
            c["reward"] = float(abs(tp - entry))
            c["tp_distance_atr"] = float(abs(tp - entry) / atr) if atr and atr > 0 else None
        return c

    @staticmethod
    def _choose_candidate(candidates: list[dict[str, Any]], tp_mode: TPMode) -> Optional[dict[str, Any]]:
        if not candidates:
            return None

        # Fill missing SL if needed (caller should set)
        # (In our flow, KEY_LEVEL candidate was created with needs_sl=True; caller will set sl/rr)
        return_mode = tp_mode

        # best-available = KL if exists else DP if exists else RR
        if return_mode == "BEST_AVAILABLE":
            for m in ("KEY_LEVEL", "DP_LEVEL", "RR"):
                for c in candidates:
                    if c.get("method") == m:
                        return c
            return candidates[0]

        if return_mode == "KEY_LEVEL":
            for c in candidates:
                if c.get("method") == "KEY_LEVEL":
                    return c
            return None

        if return_mode == "DP_LEVEL":
            for c in candidates:
                if c.get("method") == "DP_LEVEL":
                    return c
            return None

        if return_mode == "RR_ONLY":
            for c in candidates:
                if c.get("method") == "RR":
                    return c
            return None

        return candidates[0]

    # Override calculate to ensure KEY_LEVEL candidate rr is computed with SL
    def calculate_with_best_tp(
        self,
        candles: list[Any],
        *,
        zone: Any,
        direction_hint: Optional[str] = None,
        key_levels: Optional[list[Any]] = None,
        dp: Optional[Any] = None,
        current_price: Optional[float] = None,
    ) -> SLTPResult:
        """
        Alias explicite (optionnel) : même chose que calculate().
        Gardé pour compatibilité future si tu veux différencier.
        """
        return self.calculate(
            candles,
            zone=zone,
            direction_hint=direction_hint,
            key_levels=key_levels,
            dp=dp,
            current_price=current_price,
        )