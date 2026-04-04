"""
api/__init__.py — Package API IGNIS
Expose les routers FastAPI de tous les modules API.
"""

from fastapi import APIRouter

from app.api.routes_analysis import router as analysis_router
from app.api.routes_assets import router as assets_router
from app.api.routes_alerts import router as alerts_router
from app.api.routes_ignis_ai import router as ignis_ai_router
from app.api.routes_journal import router as journal_router

# ── Router principal qui agrège tous les sous-routers ─────────────────────────
api_router = APIRouter(prefix="/api/v1")

api_router.include_router(
    analysis_router,
    prefix="/analysis",
    tags=["Analysis"],
)

api_router.include_router(
    assets_router,
    prefix="/assets",
    tags=["Assets"],
)

api_router.include_router(
    alerts_router,
    prefix="/alerts",
    tags=["Alerts"],
)

api_router.include_router(
    ignis_ai_router,
    prefix="/ai",
    tags=["Ignis AI"],
)

api_router.include_router(
    journal_router,
    prefix="/journal",
    tags=["Journal"],
)

__all__ = [
    "api_router",
    "analysis_router",
    "assets_router",
    "alerts_router",
    "ignis_ai_router",
    "journal_router",
]