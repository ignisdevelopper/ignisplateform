"""
core/__init__.py — Package Core IGNIS (HLZ / Supply & Demand)

Expose les sous-modules principaux du moteur stratégie :
- market_structure   : phase, swings, SB, MTF
- base_engine        : détection/scoring bases, WB, Hidden Base
- sd_zones           : SDE, SGB, SDP, FLIPPY, FTB, Failed SDE
- pa_patterns        : ACCU, 3D, FTL, 69, Hidden SDE
- advanced_patterns  : OU, IOU, Flag Limit, Counter Attack, Ignored Accu
- decision_point     : DP, Key Levels, SL/TP, Pullback Entry
- setup_scanner      : Validator, Scorer, Pipeline

Note :
- Les détecteurs sont stateless.
- Les imports ici sont faits pour faciliter l’accès depuis le reste de l’app :
    from app.core import SetupPipeline, BaseDetector, ...
"""

# ── Market Structure ─────────────────────────────────────────────────────────
from app.core.market_structure import (
    PhaseDetector,
    PhaseDetectorConfig,
    PhaseResult,
    SwingDetector,
    SwingDetectorConfig,
    SwingPoint,
    SwingStructureResult,
    StructureBreaker,
    StructureBreakerConfig,
    StructureBreakResult,
    MultiTimeframeReader,
    MultiTFConfig,
    MultiTFResult,
    MARKET_STRUCTURE_COMPONENTS,
)

# ── Base Engine ──────────────────────────────────────────────────────────────
from app.core.base_engine import (
    BaseDetector,
    BaseDetectorConfig,
    BaseDetectionResult,
    BaseScorer,
    BaseScorerConfig,
    BaseScoreResult,
    WeakeningBaseDetector,
    WeakeningBaseConfig,
    WeakeningBaseResult,
    HiddenBaseDetector,
    HiddenBaseConfig,
    HiddenBaseResult,
    BASE_ENGINE_COMPONENTS,
)

# ── Supply & Demand Zones ────────────────────────────────────────────────────
from app.core.sd_zones import (
    SDEDetector,
    SDEConfig,
    SDEResult,
    SGBDetector,
    SGBConfig,
    SGBResult,
    SDPDetector,
    SDPConfig,
    SDPResult,
    FlippyDetector,
    FlippyConfig,
    FlippyResult,
    FTBDetector,
    FTBConfig,
    FTBResult,
    FailedSDEDetector,
    FailedSDEConfig,
    FailedSDEResult,
    SD_ZONE_COMPONENTS,
)

# ── PA Patterns ──────────────────────────────────────────────────────────────
from app.core.pa_patterns import (
    AccuDetector,
    AccuConfig,
    AccuResult,
    ThreeDrivesDetector,
    ThreeDrivesConfig,
    ThreeDrivesResult,
    FTLDetector,
    FTLConfig,
    FTLResult,
    Pattern69Detector,
    Pattern69Config,
    Pattern69Result,
    HiddenSDEDetector,
    HiddenSDEConfig,
    HiddenSDEResult,
    PA_PATTERN_DETECTORS,
)

# ── Advanced Patterns ────────────────────────────────────────────────────────
from app.core.advanced_patterns import (
    OverUnderDetector,
    OverUnderConfig,
    OverUnderResult,
    IOUDetector,
    IOUConfig,
    IOUResult,
    FlagLimitDetector,
    FlagLimitConfig,
    FlagLimitResult,
    CounterAttackDetector,
    CounterAttackConfig,
    CounterAttackResult,
    IgnoredAccuDetector,
    IgnoredAccuConfig,
    IgnoredAccuResult,
    ADVANCED_PATTERN_DETECTORS,
)

# ── Decision Point ───────────────────────────────────────────────────────────
from app.core.decision_point import (
    DPDetector,
    DPDetectorConfig,
    DPResult,
    KeyLevelDetector,
    KeyLevelConfig,
    KeyLevel,
    KeyLevelType,
    SLTPCalculator,
    SLTPConfig,
    SLTPResult,
    PullbackEntryDetector,
    PullbackEntryConfig,
    PullbackEntryResult,
    DECISION_POINT_COMPONENTS,
)

# ── Setup Scanner / Pipeline ─────────────────────────────────────────────────
from app.core.setup_scanner import (
    SetupValidator,
    SetupValidatorConfig,
    SetupValidationResult,
    SetupScorer,
    SetupScorerConfig,
    SetupScoreBreakdown,
    SetupScoreResult,
    SetupPipeline,
    SetupPipelineConfig,
    SetupPipelineResult,
    run_pipeline_for_symbol,
    SETUP_SCANNER_COMPONENTS,
)

# ── Registry global (pratique pour debug / docs) ─────────────────────────────
CORE_COMPONENTS = {
    "MARKET_STRUCTURE": MARKET_STRUCTURE_COMPONENTS,
    "BASE_ENGINE": BASE_ENGINE_COMPONENTS,
    "SD_ZONES": SD_ZONE_COMPONENTS,
    "PA_PATTERNS": PA_PATTERN_DETECTORS,
    "ADVANCED_PATTERNS": ADVANCED_PATTERN_DETECTORS,
    "DECISION_POINT": DECISION_POINT_COMPONENTS,
    "SETUP_SCANNER": SETUP_SCANNER_COMPONENTS,
}

__all__ = [
    # Registries
    "MARKET_STRUCTURE_COMPONENTS",
    "BASE_ENGINE_COMPONENTS",
    "SD_ZONE_COMPONENTS",
    "PA_PATTERN_DETECTORS",
    "ADVANCED_PATTERN_DETECTORS",
    "DECISION_POINT_COMPONENTS",
    "SETUP_SCANNER_COMPONENTS",
    "CORE_COMPONENTS",

    # Market Structure
    "PhaseDetector", "PhaseDetectorConfig", "PhaseResult",
    "SwingDetector", "SwingDetectorConfig", "SwingPoint", "SwingStructureResult",
    "StructureBreaker", "StructureBreakerConfig", "StructureBreakResult",
    "MultiTimeframeReader", "MultiTFConfig", "MultiTFResult",

    # Base Engine
    "BaseDetector", "BaseDetectorConfig", "BaseDetectionResult",
    "BaseScorer", "BaseScorerConfig", "BaseScoreResult",
    "WeakeningBaseDetector", "WeakeningBaseConfig", "WeakeningBaseResult",
    "HiddenBaseDetector", "HiddenBaseConfig", "HiddenBaseResult",

    # SD Zones
    "SDEDetector", "SDEConfig", "SDEResult",
    "SGBDetector", "SGBConfig", "SGBResult",
    "SDPDetector", "SDPConfig", "SDPResult",
    "FlippyDetector", "FlippyConfig", "FlippyResult",
    "FTBDetector", "FTBConfig", "FTBResult",
    "FailedSDEDetector", "FailedSDEConfig", "FailedSDEResult",

    # PA Patterns
    "AccuDetector", "AccuConfig", "AccuResult",
    "ThreeDrivesDetector", "ThreeDrivesConfig", "ThreeDrivesResult",
    "FTLDetector", "FTLConfig", "FTLResult",
    "Pattern69Detector", "Pattern69Config", "Pattern69Result",
    "HiddenSDEDetector", "HiddenSDEConfig", "HiddenSDEResult",

    # Advanced Patterns
    "OverUnderDetector", "OverUnderConfig", "OverUnderResult",
    "IOUDetector", "IOUConfig", "IOUResult",
    "FlagLimitDetector", "FlagLimitConfig", "FlagLimitResult",
    "CounterAttackDetector", "CounterAttackConfig", "CounterAttackResult",
    "IgnoredAccuDetector", "IgnoredAccuConfig", "IgnoredAccuResult",

    # Decision Point
    "DPDetector", "DPDetectorConfig", "DPResult",
    "KeyLevelDetector", "KeyLevelConfig", "KeyLevel", "KeyLevelType",
    "SLTPCalculator", "SLTPConfig", "SLTPResult",
    "PullbackEntryDetector", "PullbackEntryConfig", "PullbackEntryResult",

    # Setup Scanner
    "SetupValidator", "SetupValidatorConfig", "SetupValidationResult",
    "SetupScorer", "SetupScorerConfig", "SetupScoreBreakdown", "SetupScoreResult",
    "SetupPipeline", "SetupPipelineConfig", "SetupPipelineResult",
    "run_pipeline_for_symbol",
]
