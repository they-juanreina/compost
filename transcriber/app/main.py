"""FastAPI entrypoint for the compost transcriber.

Mounts the routers each subsystem (transcription, legacy ingest, frames)
ships in its own issue. /health, /transcribe (v0.1-01), and /legacy-ingest
(v0.1-02) are live; frame extraction routes land under v0.2-12.
"""

from __future__ import annotations

from fastapi import FastAPI

from . import __version__
from .health import router as health_router
from .routes.legacy import router as legacy_router
from .routes.transcribe import router as transcribe_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="compost-transcriber",
        version=__version__,
        description="Descriptive audio transcription + frame extraction + legacy ingest.",
    )
    app.include_router(health_router)
    app.include_router(transcribe_router)
    app.include_router(legacy_router)
    return app


app = create_app()
