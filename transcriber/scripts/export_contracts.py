#!/usr/bin/env python3
"""Export pydantic request models as JSON Schemas for cross-language contract tests.

The Node-side TranscriberClient and LegacyIngestClient build request bodies
that Python's pydantic models then validate. If the two sides drift, the
client hits 422 errors that don't show up in either side's unit tests
(both use mocks at their own boundary).

This script generates JSON Schema files the Node test suite validates
its emitted bodies against. Run on demand:

    python -m transcriber.scripts.export_contracts

The output lives at `cli/contracts/<route>-request.schema.json`. Commit
those — they're the canonical contract. If the pydantic model changes
without a regen, CI's contract test fails and the developer regenerates.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Make the package importable when called as a script (rather than -m).
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from app.routes.transcribe import TranscribeRequest  # noqa: E402

CONTRACTS_DIR = HERE.parent.parent / "cli" / "contracts"


def write_schema(model: type, filename: str) -> None:
    schema = model.model_json_schema()
    out_path = CONTRACTS_DIR / filename
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out_path}")


def main() -> None:
    write_schema(TranscribeRequest, "transcribe-request.schema.json")
    # legacy-ingest contract added when v0.1-02 (PR #147) merges.


if __name__ == "__main__":
    main()
