"""POST /legacy-ingest — normalize a legacy document into a transcript.json.

The Node-side legacy-worker (cli/src/loops/legacy_worker.ts) pulls
`legacy-ingest` jobs from the queue and POSTs each here. The route dispatches
by file extension to the pure ingestors in `app/legacy.py`, then writes the
normalized JSON to `<seed>/legacy/<basename>.json`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from ..legacy import ingest as ingest_legacy

router = APIRouter()


class LegacyIngestRequest(BaseModel):
    seed_path: str = Field(..., description="Absolute path to the seed root.")
    source_path: str = Field(..., description="Absolute path to the asset to ingest.")
    # CSV/XLSX column mapping — defaults work for our own fact_utterances shape.
    text_col: str = Field("text", description="Column holding the utterance text (CSV/XLSX).")
    speaker_col: str | None = Field(None, description="Optional column for speaker label.")
    sheet: str | None = Field(None, description="Optional XLSX sheet name (defaults to active).")


class LegacyIngestResponse(BaseModel):
    source_path: str
    normalized_path: str
    utterance_count: int
    status: str  # ok | empty | failed


@router.post(
    "/legacy-ingest",
    response_model=LegacyIngestResponse,
    status_code=status.HTTP_200_OK,
    summary="Normalize a PDF/DOCX/PPTX/CSV/XLSX/TXT/MD into a transcript-shaped JSON.",
)
def post_legacy_ingest(req: LegacyIngestRequest) -> LegacyIngestResponse:
    src = Path(req.source_path)
    seed = Path(req.seed_path)
    if not src.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"source not found: {req.source_path}",
        )
    if not seed.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"seed not found: {req.seed_path}",
        )

    kwargs: dict[str, Any] = {"text_col": req.text_col}
    if req.speaker_col is not None:
        kwargs["speaker_col"] = req.speaker_col
    if req.sheet is not None:
        kwargs["sheet"] = req.sheet

    try:
        doc = ingest_legacy(src, **kwargs)
    except ValueError as e:
        # Unsupported ext or missing column — surface as 422 so the worker
        # can mark the job failed and the CLI can show the researcher what's wrong.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"invalid_input: {e}",
        ) from e
    except RuntimeError as e:
        # Missing optional dep (python-docx, openpyxl, etc.) — 503 so the
        # CLI can route to `compost setup --fix`.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"dep_missing: {e}",
        ) from e

    # Write normalized JSON under <seed>/legacy/<basename>.json
    legacy_dir = seed / "legacy"
    legacy_dir.mkdir(parents=True, exist_ok=True)
    out_path = legacy_dir / f"{src.stem}.json"
    out_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    utt_count = len(doc.get("utterances", []))
    return LegacyIngestResponse(
        source_path=req.source_path,
        normalized_path=str(out_path),
        utterance_count=utt_count,
        status="ok" if utt_count > 0 else "empty",
    )


__all__ = ["router", "LegacyIngestRequest", "LegacyIngestResponse"]
