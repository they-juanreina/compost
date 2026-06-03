"""Health endpoint for the transcriber service.

ROADMAP § Verification — `compost watch` and the CLI probe this on startup to
confirm the transcriber container is reachable before queuing work.
"""

from __future__ import annotations

import platform
import sys
from importlib.metadata import PackageNotFoundError, version

from fastapi import APIRouter
from pydantic import BaseModel

from . import __version__

router = APIRouter()


class HealthResponse(BaseModel):
    """Stable contract for /health. CLI parses these fields."""

    status: str
    service: str
    versions: dict[str, str | None]


def _safe_version(pkg: str) -> str | None:
    """Return the installed version of `pkg`, or None if it isn't installed.

    Model-heavy optional deps (whisperx, pyannote.audio, silero-vad) are
    declared in `pyproject.toml` under the `asr` extra and only installed
    when their respective issues land (#9-#15). Until then, /health
    reports them as `null` so the CLI can tell the user what's missing.
    """
    try:
        return version(pkg)
    except PackageNotFoundError:
        return None


@router.get("/health", response_model=HealthResponse)
def get_health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        service="compost-transcriber",
        versions={
            "transcriber": __version__,
            "python": platform.python_version(),
            "fastapi": _safe_version("fastapi"),
            "uvicorn": _safe_version("uvicorn"),
            "whisperx": _safe_version("whisperx"),
            "pyannote.audio": _safe_version("pyannote.audio"),
            "silero-vad": _safe_version("silero-vad"),
        },
    )


__all__ = ["router", "HealthResponse", "get_health"]


def _python_metadata_check() -> None:
    """Self-check at import time: make sure we're on a supported runtime."""
    major, minor = sys.version_info[:2]
    if (major, minor) < (3, 11):
        raise RuntimeError(f"compost-transcriber requires Python >=3.11, got {major}.{minor}")


_python_metadata_check()
