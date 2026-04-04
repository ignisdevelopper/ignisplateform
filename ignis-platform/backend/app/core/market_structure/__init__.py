"""
core/market_structure/__init__.py — Package Market Structure IGNIS (HLZ)

Ce package analyse la structure de marché :
- phase_detector.py      : détecte les phases RALLY / DROP / BASE / CHOP
- swing_detector.py      : détecte swings HH/HL/LH/LL (pivots)
- structure_breaker.py   : détecte les cassures de structure (SB)
- multi_tf_reader.py     : lecture multi-timeframe (HTF -> LTF)

Consommé par :
- core/setup_scanner/setup_pipeline.py
- core/setup_scanner/setup_validator.py
- core/sd_zones/* (validation zones avec contexte structure)
"""

from app.core.market_structure.phase_detector import (
    PhaseDetector,
    PhaseDetectorConfig,
    PhaseResult,
)

from app.core.market_structure.swing_detector import (
    SwingDetector,
    SwingDetectorConfig,
    SwingPoint,
    SwingStructureResult,
)

from app.core.market_structure.structure_breaker import (
    StructureBreaker,
    StructureBreakerConfig,
    StructureBreakResult,
)

from app.core.market_structure.multi_tf_reader import (
    MultiTimeframeReader,
    MultiTFConfig,
    MultiTFResult,
)

MARKET_STRUCTURE_COMPONENTS = {
    "PHASE_DETECTOR": PhaseDetector,
    "SWING_DETECTOR": SwingDetector,
    "STRUCTURE_BREAKER": StructureBreaker,
    "MULTI_TF_READER": MultiTimeframeReader,
}

__all__ = [
    # Phase
    "PhaseDetector",
    "PhaseDetectorConfig",
    "PhaseResult",

    # Swings
    "SwingDetector",
    "SwingDetectorConfig",
    "SwingPoint",
    "SwingStructureResult",

    # Structure break
    "StructureBreaker",
    "StructureBreakerConfig",
    "StructureBreakResult",

    # MTF
    "MultiTimeframeReader",
    "MultiTFConfig",
    "MultiTFResult",

    # Registry
    "MARKET_STRUCTURE_COMPONENTS",
]
