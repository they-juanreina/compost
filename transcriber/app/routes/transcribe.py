"""POST /transcribe — orchestrate the full descriptive pipeline (v0.1-01).

Body shape mirrors the CLI's `TranscriberClient.transcribe()` contract: the
client passes the seed root, the session id, and the absolute source path
(already moved into `sessions/<sid>/source.<ext>` by the inbox watcher).

The route returns the transcript path and a status code the worker uses to
either commit the job, requeue for retry, or surface needs_speaker_labels to
the researcher.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..asr import ASRConfig
from ..pipeline import (
    PipelineBackends,
    PipelineConfig,
    run_pipeline,
    write_transcript,
)

router = APIRouter()


class TranscribeRequest(BaseModel):
    """JSON body for POST /transcribe."""

    seed_path: str = Field(..., description="Absolute path to the seed root (Seeds/<name>/).")
    session_id: str = Field(..., pattern=r"^[A-Za-z0-9_-]+$")
    source_path: str = Field(..., description="Absolute path to the audio/video file.")
    language: str | None = Field(None, description="Optional language hint (e.g. 'es-CO').")
    model_name: str = Field("large-v3-turbo", description="Whisper model id.")
    device: str = Field("auto", description="Device: auto | cpu | cuda | mps.")
    compute_type: str = Field("int8", description="Compute precision (int8|float16|float32).")


class TranscribeResponse(BaseModel):
    """Response shape mirroring `TranscriberClient.TranscribeResponse`."""

    session_id: str
    transcript_path: str
    status: str  # ok | needs_speaker_labels | failed_transcription


def _build_backends() -> PipelineBackends:
    """Resolve real backends from the environment.

    Each backend is lazy-loaded by its own module; this function just decides
    *which* backend to inject. In production all three are None → each module
    falls back to its real implementation (WhisperX / pyannote / Silero). In
    tests we override via FastAPI's `app.dependency_overrides`.
    """
    return PipelineBackends(vad=None, asr=None, diarization=None)


def _build_pipeline_config(req: TranscribeRequest) -> PipelineConfig:
    asr = ASRConfig(
        model_name=req.model_name,
        device=req.device,
        compute_type=req.compute_type,
        language=req.language,
        event_tags=True,
    )
    return PipelineConfig(asr=asr)


@router.post(
    "/transcribe",
    response_model=TranscribeResponse,
    status_code=status.HTTP_200_OK,
    summary="Run the descriptive transcription pipeline on a session's source media.",
)
def post_transcribe(
    req: TranscribeRequest,
    backends: Annotated[PipelineBackends, Depends(_build_backends)],
) -> TranscribeResponse:
    if not Path(req.source_path).exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"source not found: {req.source_path}",
        )
    if not Path(req.seed_path).exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"seed not found: {req.seed_path}",
        )

    config = _build_pipeline_config(req)

    try:
        transcript = run_pipeline(
            seed_path=req.seed_path,
            session_id=req.session_id,
            source_path=req.source_path,
            config=config,
            backends=backends,
        )
    except RuntimeError as e:
        # Backend missing weights → distinguishable from generic failure so the
        # CLI can suggest `compost setup --fix`.
        if "asr extra" in str(e).lower() or "HUGGINGFACE_TOKEN" in str(e):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"model_missing: {e}",
            ) from e
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"failed_transcription: {e}",
        ) from e

    transcript_path = write_transcript(req.seed_path, req.session_id, transcript)

    return TranscribeResponse(
        session_id=req.session_id,
        transcript_path=transcript_path,
        status=transcript.get("status", "ok"),
    )


def hf_token_present() -> bool:
    """Helper exposed for the /compost-setup doctor: whether a HuggingFace
    token is on the environment (does NOT validate it works against pyannote)."""
    return bool(os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("HF_TOKEN"))


__all__ = ["router", "TranscribeRequest", "TranscribeResponse", "hf_token_present"]
