"""Verify the committed JSON Schema contracts are in sync with the pydantic models.

If `app/routes/transcribe.py:TranscribeRequest` changes, the committed schema
at `cli/contracts/transcribe-request.schema.json` must be regenerated via:

    python -m transcriber.scripts.export_contracts

This test fails when the two drift, surfacing the exact diff so the developer
knows to regenerate.

The contract is consumed by the Node-side `cli/src/transcriber_client.contract.test.ts`,
which validates the client's emitted body against this schema. Together, the
two tests catch the bug class that #148 exemplified — request-body shape drift
across language boundaries.
"""
from __future__ import annotations

import json
from pathlib import Path

from app.routes.transcribe import TranscribeRequest

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = REPO_ROOT / "cli" / "contracts" / "transcribe-request.schema.json"


def test_transcribe_request_contract_is_in_sync():
    expected = TranscribeRequest.model_json_schema()
    committed = json.loads(CONTRACT_PATH.read_text())
    assert expected == committed, (
        f"\n{CONTRACT_PATH} is out of sync with TranscribeRequest. "
        "Regenerate via:\n\n"
        "    python -m transcriber.scripts.export_contracts\n"
    )
