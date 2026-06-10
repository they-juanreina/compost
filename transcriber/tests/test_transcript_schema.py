"""Schema-conformance regression guard for native transcriber output.

The native pipeline (parakeet/whisper + pyannote) must produce transcripts that
pass ``schema/transcript.schema.json`` — the contract the UI and ``compost
validate seed`` / export gates depend on. Before this guard the ASR smoke test
only checked loose structural facts (speakers/words present), so a real session
shipped ~700 schema errors from systematic mismatches: raw ``SPEAKER_NN`` ids, a
non-schema ``diarization`` utterance key, typed ``CUE-OV-`` ids, and null
provenance fields — plus a latent ``status`` one on low-confidence sessions.

This validates the REAL ``run_pipeline`` output (built via ``tests.native_fixture``)
against the committed JSON Schema, and keeps the committed fixture — consumed by
the CLI's ``validateTranscript`` test — in sync.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from tests.native_fixture import (
    FIXTURE_PATH,
    build_low_confidence_transcript,
    build_native_transcript,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO_ROOT / "schema" / "transcript.schema.json"


def _schema_errors(transcript: dict) -> list[str]:
    schema = json.loads(SCHEMA_PATH.read_text())
    validator = Draft202012Validator(schema)
    return [
        f"{'/'.join(map(str, e.path)) or '<root>'}: {e.message}"
        for e in validator.iter_errors(transcript)
    ]


def test_native_pipeline_output_is_schema_valid():
    errors = _schema_errors(build_native_transcript())
    assert errors == [], "native transcript violates schema:\n" + "\n".join(errors)


def test_low_confidence_output_sets_status_and_is_schema_valid():
    transcript = build_low_confidence_transcript()
    assert transcript["status"] == "needs_speaker_labels"
    errors = _schema_errors(transcript)
    assert errors == [], "low-confidence transcript violates schema:\n" + "\n".join(errors)


def test_each_fixed_mismatch_holds():
    # Pin the individual producer fixes so a regression points at the exact field
    # rather than only failing the whole-document schema check.
    t = build_native_transcript()
    sid = re.compile(r"^S[0-9]+$")
    assert all(sid.fullmatch(s["id"]) for s in t["speakers"]), t["speakers"]
    assert all(sid.fullmatch(u["speaker_id"]) for u in t["utterances"])
    assert all(re.fullmatch(r"CUE-[0-9]{3,}", c["id"]) for c in t["cues"]), t["cues"]
    assert all("confidence" in u["diarization"] for u in t["utterances"])
    assert "frame_capture" not in t["provenance"]
    assert "frame_annotation" not in t["provenance"]
    # The overlap cue and both tag-derived cues all made it in.
    assert {"overlap", "laughter", "sigh"} <= {c["kind"] for c in t["cues"]}


def test_committed_fixture_is_in_sync():
    if not FIXTURE_PATH.exists():
        pytest.fail(
            f"missing {FIXTURE_PATH}; generate it with "
            "`python scripts/export_transcript_fixture.py`"
        )
    committed = json.loads(FIXTURE_PATH.read_text())
    assert committed == build_native_transcript(), (
        f"{FIXTURE_PATH} is stale — regenerate with "
        "`python scripts/export_transcript_fixture.py`"
    )
