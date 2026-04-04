"""
core/base_engine/__init__.py — Package Base Engine IGNIS (HLZ / Supply & Demand)

Ce package gère la détection et la qualification des "bases" HLZ :
- BaseDetector   : détecte les bases (RBR / DBD / RBD / DBR)
- BaseScorer     : score la solidité d’une base (0..100)
- WeakeningBase  : détecte les bases affaiblies (retours multiples, absorption)
- HiddenBase     : détecte les bases cachées (kissing candles / micro-base LTF)

Ces modules sont consommés par :
- core/sd_zones/* (SDE/SGB/SDP/FTB/Failed SDE)
- core/setup_scanner/setup_pipeline.py
"""

# ── Détection de base (RBR/DBD/RBD/DBR) ───────────────────────────────────────
from app.core.base_engine.base_detector import (
    BaseDetector,
    BaseDetectorConfig,
    BaseDetectionResult,
)

# ── Scoring base ─────────────────────────────────────────────────────────────
from app.core.base_engine.base_scorer import (
    BaseScorer,
    BaseScorerConfig,
    BaseScoreResult,
)

# ── Weakening Base ───────────────────────────────────────────────────────────
from app.core.base_engine.weakening_base import (
    WeakeningBaseDetector,
    WeakeningBaseConfig,
    WeakeningBaseResult,
)

# ── Hidden Base (kissing / micro-base) ───────────────────────────────────────
from app.core.base_engine.hidden_base import (
    HiddenBaseDetector,
    HiddenBaseConfig,
    HiddenBaseResult,
)

# ── Registry (pratique pour pipeline/scanner) ─────────────────────────────────
BASE_ENGINE_COMPONENTS = {
    "BASE_DETECTOR": BaseDetector,
    "BASE_SCORER": BaseScorer,
    "WEAKENING_BASE": WeakeningBaseDetector,
    "HIDDEN_BASE": HiddenBaseDetector,
}

__all__ = [
    # Base detector
    "BaseDetector",
    "BaseDetectorConfig",
    "BaseDetectionResult",

    # Base scorer
    "BaseScorer",
    "BaseScorerConfig",
    "BaseScoreResult",

    # Weakening base
    "WeakeningBaseDetector",
    "WeakeningBaseConfig",
    "WeakeningBaseResult",

    # Hidden base
    "HiddenBaseDetector",
    "HiddenBaseConfig",
    "HiddenBaseResult",

    # Registry
    "BASE_ENGINE_COMPONENTS",
]