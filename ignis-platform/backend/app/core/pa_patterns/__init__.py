"""
core/pa_patterns/__init__.py — Package Price Approaching (PA) Patterns IGNIS (HLZ)

PA (Price Approaching) = patterns d'approche d'une zone S&D / SGB :
- accu_detector.py     : ACCU (escalier / compression)
- three_drives.py      : Three Drives (3D)
- ftl_detector.py      : Flip Trend Line (FTL)
- pattern_69.py        : Pattern 69
- hidden_sde.py        : Hidden SDE / FBO / FLIPPY confluence

Consommé par :
- core/setup_scanner/setup_pipeline.py
- core/setup_scanner/setup_validator.py
- core/setup_scanner/setup_scorer.py
"""

from app.core.pa_patterns.accu_detector import (
    AccuDetector,
    AccuConfig,
    AccuResult,
)

from app.core.pa_patterns.three_drives import (
    ThreeDrivesDetector,
    ThreeDrivesConfig,
    ThreeDrivesResult,
)

from app.core.pa_patterns.ftl_detector import (
    FTLDetector,
    FTLConfig,
    FTLResult,
)

from app.core.pa_patterns.pattern_69 import (
    Pattern69Detector,
    Pattern69Config,
    Pattern69Result,
)

from app.core.pa_patterns.hidden_sde import (
    HiddenSDEDetector,
    HiddenSDEConfig,
    HiddenSDEResult,
)

PA_PATTERN_DETECTORS = {
    "ACCU": AccuDetector,
    "THREE_DRIVES": ThreeDrivesDetector,
    "FTL": FTLDetector,
    "PATTERN_69": Pattern69Detector,
    "HIDDEN_SDE": HiddenSDEDetector,
}

__all__ = [
    # ACCU
    "AccuDetector",
    "AccuConfig",
    "AccuResult",

    # 3D
    "ThreeDrivesDetector",
    "ThreeDrivesConfig",
    "ThreeDrivesResult",

    # FTL
    "FTLDetector",
    "FTLConfig",
    "FTLResult",

    # 69
    "Pattern69Detector",
    "Pattern69Config",
    "Pattern69Result",

    # Hidden SDE
    "HiddenSDEDetector",
    "HiddenSDEConfig",
    "HiddenSDEResult",

    # Registry
    "PA_PATTERN_DETECTORS",
]
