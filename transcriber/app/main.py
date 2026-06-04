"""FastAPI entrypoint for the compost transcriber.

Mounts the routers each subsystem (transcription, frames, legacy ingest)
ships in its own issue. /health and /transcribe (v0.1-01) are live; legacy
ingest and frame extraction routes land under v0.1-02 and v0.2-12.
"""

from __future__ import annotations

from fastapi import FastAPI

from . import __version__
from .health import router as health_router
from .routes.transcribe import router as transcribe_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="compost-transcriber",
        version=__version__,
        description="Descriptive audio transcription + frame extraction + legacy ingest.",
    )
    app.include_router(health_router)
    app.include_router(transcribe_router)
    return app


app = create_app()
