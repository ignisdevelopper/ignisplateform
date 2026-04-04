"""
core/advanced_patterns/__init__.py — Package Advanced Patterns IGNIS (HLZ)
Expose les détecteurs de patterns avancés :
- Over & Under (OU) + Golden Zone
- Ignored Over & Under (IOU)
- Flag Limit (FL)
- Counter Attack (CA)
- Ignored Accumulation (IA)

Ces modules sont consommés par :
- core/setup_scanner/setup_pipeline.py
- core/setup_scanner/setup_validator.py
- core/setup_scanner/setup_scorer.py
"""

# OU (Over & Under)
from app.core.advanced_patterns.over_under import (
    OverUnderDetector,
    OverUnderConfig,
    OverUnderResult,
)

# IOU (Ignored Over & Under)
from app.core.advanced_patterns.iou_detector import (
    IOUDetector,
    IOUConfig,
    IOUResult,
)

# Flag Limit
from app.core.advanced_patterns.flag_limit import (
    FlagLimitDetector,
    FlagLimitConfig,
    FlagLimitResult,
)

# Counter Attack
from app.core.advanced_patterns.counter_attack import (
    CounterAttackDetector,
    CounterAttackConfig,
    CounterAttackResult,
)

# Ignored Accumulation
from app.core.advanced_patterns.ignored_accu import (
    IgnoredAccuDetector,
    IgnoredAccuConfig,
    IgnoredAccuResult,
)

# ── Registry (pratique pour pipeline/scanner) ─────────────────────────────────

ADVANCED_PATTERN_DETECTORS = {
    "OVER_UNDER": OverUnderDetector,
    "IOU": IOUDetector,
    "FLAG_LIMIT": FlagLimitDetector,
    "COUNTER_ATTACK": CounterAttackDetector,
    "IGNORED_ACCU": IgnoredAccuDetector,
}

__all__ = [
    # OU
    "OverUnderDetector",
    "OverUnderConfig",
    "OverUnderResult",

    # IOU
    "IOUDetector",
    "IOUConfig",
    "IOUResult",

    # Flag Limit
    "FlagLimitDetector",
    "FlagLimitConfig",
    "FlagLimitResult",

    # Counter Attack
    "CounterAttackDetector",
    "CounterAttackConfig",
    "CounterAttackResult",

    # Ignored Accu
    "IgnoredAccuDetector",
    "IgnoredAccuConfig",
    "IgnoredAccuResult",

    # Registry
    "ADVANCED_PATTERN_DETECTORS",
]