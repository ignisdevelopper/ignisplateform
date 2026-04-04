"""
core/sd_zones/__init__.py — Package Supply & Demand Zones (SDE/SGB/SDP/FLIPPY/FTB) (IGNIS / HLZ)

Ce package regroupe les détecteurs et règles autour des zones Supply & Demand :
- sde_detector.py     : validation SDE (engulf de base / departure)
- sgb_detector.py     : création/validation SGB (zone d'entrée à partir d'une base)
- sdp_detector.py     : validation SDP (HEAD tenu)
- flippy_detector.py  : détection zone FLIPPY (manip / flip S↔D)
- ftb_detector.py     : First Time Back (FTB) + touches
- failed_sde.py       : règles Failed SDE (invalidations)

Consommé par :
- core/setup_scanner/setup_pipeline.py
- core/setup_scanner/setup_validator.py
- core/setup_scanner/setup_scorer.py
"""

from app.core.sd_zones.sde_detector import (
    SDEDetector,
    SDEConfig,
    SDEResult,
)

from app.core.sd_zones.sgb_detector import (
    SGBDetector,
    SGBConfig,
    SGBResult,
)

from app.core.sd_zones.sdp_detector import (
    SDPDetector,
    SDPConfig,
    SDPResult,
)

from app.core.sd_zones.flippy_detector import (
    FlippyDetector,
    FlippyConfig,
    FlippyResult,
)

from app.core.sd_zones.ftb_detector import (
    FTBDetector,
    FTBConfig,
    FTBResult,
)

from app.core.sd_zones.failed_sde import (
    FailedSDEDetector,
    FailedSDEConfig,
    FailedSDEResult,
)

SD_ZONE_COMPONENTS = {
    "SDE": SDEDetector,
    "SGB": SGBDetector,
    "SDP": SDPDetector,
    "FLIPPY": FlippyDetector,
    "FTB": FTBDetector,
    "FAILED_SDE": FailedSDEDetector,
}

__all__ = [
    # SDE
    "SDEDetector",
    "SDEConfig",
    "SDEResult",

    # SGB
    "SGBDetector",
    "SGBConfig",
    "SGBResult",

    # SDP
    "SDPDetector",
    "SDPConfig",
    "SDPResult",

    # Flippy
    "FlippyDetector",
    "FlippyConfig",
    "FlippyResult",

    # FTB
    "FTBDetector",
    "FTBConfig",
    "FTBResult",

    # Failed SDE
    "FailedSDEDetector",
    "FailedSDEConfig",
    "FailedSDEResult",

    # Registry
    "SD_ZONE_COMPONENTS",
]
