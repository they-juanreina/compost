"""FastAPI entrypoint for the compost transcriber.

Mounts the routers each subsystem (transcription, frames, legacy ingest)
ships in its own issue. Today only /health is wired up; real workers land
under #9-#15 (audio) and #14-#15 (frames).
"""

from __future__ import annotations

from fastapi import FastAPI

from . import __version__
from .health import router as health_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="compost-transcriber",
        version=__version__,
        description="Descriptive audio transcription + frame extraction + legacy ingest.",
    )
    app.include_router(health_router)
    return app


app = create_app()
