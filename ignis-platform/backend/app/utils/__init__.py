"""
utils/__init__.py — Utilities package IGNIS

Expose les helpers communs :
- logger : get_logger()
- candle_utils : helpers bougies
- math_utils : helpers calculs prix / RR

Note : imports en try/except pour ne pas casser l’app si un module est en cours
de refactor.
"""

# ── Logger ───────────────────────────────────────────────────────────────────
try:
    from app.utils.logger import get_logger
except Exception:  # pragma: no cover
    get_logger = None  # type: ignore

# ── Candle utils ─────────────────────────────────────────────────────────────
try:
    from app.utils.candle_utils import *  # noqa: F403
except Exception:  # pragma: no cover
    pass

# ── Math utils ───────────────────────────────────────────────────────────────
try:
    from app.utils.math_utils import *  # noqa: F403
except Exception:  # pragma: no cover
    pass

__all__ = [
    "get_logger",
]