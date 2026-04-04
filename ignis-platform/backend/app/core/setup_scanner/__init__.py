"""
core/setup_scanner/__init__.py — Package Setup Scanner IGNIS (HLZ)

Ce package orchestre toute la stratégie HLZ pour produire un SetupResult :
- setup_validator.py : règles VALID / PENDING / INVALID / WATCH / EXPIRED
- setup_scorer.py    : scoring global (0..100) du setup
- setup_pipeline.py  : pipeline orchestrateur (MTF, structure, base, zones, PA, advanced, DP, SL/TP)

Consommé par :
- API (routes_analysis.py / routes_assets.py)
- Alerts (alert_engine)
"""

from app.core.setup_scanner.setup_validator import (
    SetupValidator,
    SetupValidatorConfig,
    SetupValidationResult,
)

from app.core.setup_scanner.setup_scorer import (
    SetupScorer,
    SetupScorerConfig,
    SetupScoreBreakdown,
    SetupScoreResult,
)

from app.core.setup_scanner.setup_pipeline import (
    SetupPipeline,
    SetupPipelineConfig,
    SetupPipelineResult,
    run_pipeline_for_symbol,
)

SETUP_SCANNER_COMPONENTS = {
    "VALIDATOR": SetupValidator,
    "SCORER": SetupScorer,
    "PIPELINE": SetupPipeline,
}

__all__ = [
    # Validator
    "SetupValidator",
    "SetupValidatorConfig",
    "SetupValidationResult",

    # Scorer
    "SetupScorer",
    "SetupScorerConfig",
    "SetupScoreBreakdown",
    "SetupScoreResult",

    # Pipeline
    "SetupPipeline",
    "SetupPipelineConfig",
    "SetupPipelineResult",
    "run_pipeline_for_symbol",

    # Registry
    "SETUP_SCANNER_COMPONENTS",
]
