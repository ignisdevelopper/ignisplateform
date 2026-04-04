"""
core/decision_point/__init__.py — Package Decision Point IGNIS (HLZ)

Ce package regroupe les composants Decision Point (DP) :
- dp_detector.py        : détection des 4 types DP (SDP, SB_LEVEL, TREND_LINE, KEY_LEVEL)
- key_level.py          : calcul / détection de Key Levels (old high/low, round numbers, SSR flip)
- sl_tp_calculator.py   : calcul SL/TP et RR à partir d'une zone et d'un DP
- pe_detector.py        : Pullback Entry (PE) / conditions d'entrée

Consommé par :
- core/setup_scanner/setup_pipeline.py
- core/setup_scanner/setup_validator.py
- core/setup_scanner/setup_scorer.py
"""

from app.core.decision_point.dp_detector import (
    DPDetector,
    DPDetectorConfig,
    DPResult,
)

from app.core.decision_point.key_level import (
    KeyLevelDetector,
    KeyLevelConfig,
    KeyLevel,
    KeyLevelType,
)

from app.core.decision_point.sl_tp_calculator import (
    SLTPCalculator,
    SLTPConfig,
    SLTPResult,
)

from app.core.decision_point.pe_detector import (
    PullbackEntryDetector,
    PullbackEntryConfig,
    PullbackEntryResult,
)

DECISION_POINT_COMPONENTS = {
    "DP_DETECTOR": DPDetector,
    "KEY_LEVEL": KeyLevelDetector,
    "SL_TP": SLTPCalculator,
    "PULLBACK_ENTRY": PullbackEntryDetector,
}

__all__ = [
    # DP detector
    "DPDetector",
    "DPDetectorConfig",
    "DPResult",

    # Key levels
    "KeyLevelDetector",
    "KeyLevelConfig",
    "KeyLevel",
    "KeyLevelType",

    # SL/TP
    "SLTPCalculator",
    "SLTPConfig",
    "SLTPResult",

    # Pullback Entry
    "PullbackEntryDetector",
    "PullbackEntryConfig",
    "PullbackEntryResult",

    # Registry
    "DECISION_POINT_COMPONENTS",
]
