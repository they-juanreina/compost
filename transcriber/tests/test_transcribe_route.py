"""Integration test for POST /transcribe (v0.1-01).

Exercises the full pipeline orchestration with fake backends — no model
weights required. The fakes match the protocol shapes the real backends
satisfy in production. End-to-end with real WhisperX + pyannote is a manual
smoke test inside the container; this test guards the route contract.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.pipeline import PipelineBackends
from app.routes.transcribe import _build_backends

# --- Fake backends ---------------------------------------------------------


class FakeVADBackend:
    """Returns two speech segments with a 4-second gap → one first-class silence.

    The two segments carry different RMS energies so the prosody stage can
    bucket utterance volume (quiet first segment, loud second).
    """

    def speech_timestamps(self, audio_path: str) -> list[dict[str, Any]]:
        return [
            {"start_ms": 0, "end_ms": 5000, "energy": 0.04},
            {"start_ms": 9000, "end_ms": 14000, "energy": 0.20},
        ]


class FakeWhisperBackend:
    """Returns two utterances; second contains a [sigh] event tag."""

    def transcribe(self, audio_path: str) -> dict[str, Any]:
        return {
            "language": "es-CO",
            "segments": [
                {
                    "start": 0.0,
                    "end": 5.0,
                    "text": "¿Qué haces cuando entra una alerta automática?",
                    "speaker": "S1",
                    "words": [
                        {"word": "¿Qué", "start": 0.0, "end": 0.3, "score": 0.99},
                        {"word": "haces", "start": 0.3, "end": 0.6, "score": 0.98},
                    ],
                },
                {
                    "start": 9.0,
                    "end": 14.0,
                    "text": "[sigh] no sé si confiar.",
                    "speaker": "S2",
                    "words": [
                        {"word": "no", "start": 9.3, "end": 9.5, "score": 0.95},
                        {"word": "sé", "start": 9.5, "end": 9.7, "score": 0.94},
                    ],
                },
            ],
        }


class FakeDiarizationBackend:
    """Two distinct speakers; turn boundaries match the segments."""

    def diarize(self, audio_path: str) -> list[dict[str, Any]]:
        return [
            {"start_ms": 0, "end_ms": 5000, "speaker": "S1"},
            {"start_ms": 9000, "end_ms": 14000, "speaker": "S2"},
        ]


# --- Fixtures --------------------------------------------------------------


@pytest.fixture
def fake_backends() -> PipelineBackends:
    return PipelineBackends(
        vad=FakeVADBackend(),
        asr=FakeWhisperBackend(),
        diarization=FakeDiarizationBackend(),
    )


@pytest.fixture
def seed_dir(tmp_path: Path) -> Path:
    seed = tmp_path / "Seeds" / "test-seed"
    (seed / "sessions" / "_inbox").mkdir(parents=True)
    return seed


@pytest.fixture
def source_audio(seed_dir: Path) -> Path:
    session_dir = seed_dir / "sessions" / "S001"
    session_dir.mkdir(parents=True)
    # The file exists; ffprobe will report duration=0 in CI which is fine for the test.
    src = session_dir / "source.mp3"
    src.write_bytes(b"")  # placeholder; the fake ASR doesn't actually decode
    return src


@pytest.fixture
def client(fake_backends: PipelineBackends) -> TestClient:
    app = create_app()
    app.dependency_overrides[_build_backends] = lambda: fake_backends
    return TestClient(app)


# --- Tests -----------------------------------------------------------------


def test_transcribe_returns_200_and_writes_transcript_json(
    client: TestClient, seed_dir: Path, source_audio: Path
) -> None:
    res = client.post(
        "/transcribe",
        json={
            "seed_path": str(seed_dir),
            "session_id": "S001",
            "source_path": str(source_audio),
            "language": "es-CO",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["session_id"] == "S001"
    assert body["status"] in {"ok", "needs_speaker_labels"}
    transcript_path = Path(body["transcript_path"])
    assert transcript_path.exists()


def test_transcript_has_speakers_utterances_silences_cues(
    client: TestClient, seed_dir: Path, source_audio: Path
) -> None:
    res = client.post(
        "/transcribe",
        json={
            "seed_path": str(seed_dir),
            "session_id": "S001",
            "source_path": str(source_audio),
        },
    )
    transcript = json.loads(Path(res.json()["transcript_path"]).read_text())

    # Schema basics
    assert transcript["schema_version"] == "1.0"
    assert transcript["session_id"] == "S001"
    assert transcript["language"] == "es-CO"

    # Two speakers, diarized
    assert len(transcript["speakers"]) == 2
    assert {s["id"] for s in transcript["speakers"]} == {"S1", "S2"}

    # Two utterances with speaker_id assigned
    assert len(transcript["utterances"]) == 2
    assert transcript["utterances"][0]["speaker_id"] == "S1"
    assert transcript["utterances"][1]["speaker_id"] == "S2"

    # The [sigh] tag was extracted into cues[] and removed from text
    assert any(c["kind"] == "sigh" for c in transcript["cues"])
    assert "[sigh]" not in transcript["utterances"][1]["text"]

    # Silence between segments was detected and typed
    assert len(transcript["silences"]) >= 1
    sil = transcript["silences"][0]
    assert sil["context"] in {"after_question", "thinking", "mid_utterance", "interruption"}

    # Provenance recorded
    assert transcript["provenance"]["asr_model"]
    assert transcript["provenance"]["diarizer"]


def test_prosody_volume_wired_from_vad_energy(
    client: TestClient, seed_dir: Path, source_audio: Path
) -> None:
    # End-to-end guard that the per-utterance VAD RMS energy reaches the prosody
    # stage (pipeline.py step 8). The fake VAD reports a quiet first segment and
    # a loud second one, so the two utterances must NOT both be "normal".
    res = client.post(
        "/transcribe",
        json={
            "seed_path": str(seed_dir),
            "session_id": "S001",
            "source_path": str(source_audio),
        },
    )
    transcript = json.loads(Path(res.json()["transcript_path"]).read_text())
    volumes = [u["prosody"]["volume"] for u in transcript["utterances"]]
    assert volumes == ["low", "high"]


def test_transcribe_404_when_source_missing(
    client: TestClient, seed_dir: Path
) -> None:
    res = client.post(
        "/transcribe",
        json={
            "seed_path": str(seed_dir),
            "session_id": "S099",
            "source_path": str(seed_dir / "sessions" / "S099" / "source.mp3"),
        },
    )
    assert res.status_code == 404
    assert "source not found" in res.json()["detail"]


def test_transcribe_404_when_seed_missing(
    client: TestClient, tmp_path: Path, source_audio: Path
) -> None:
    res = client.post(
        "/transcribe",
        json={
            "seed_path": str(tmp_path / "Seeds" / "does-not-exist"),
            "session_id": "S001",
            "source_path": str(source_audio),
        },
    )
    assert res.status_code == 404
    assert "seed not found" in res.json()["detail"]


def test_transcribe_rejects_invalid_session_id(
    client: TestClient, seed_dir: Path, source_audio: Path
) -> None:
    res = client.post(
        "/transcribe",
        json={
            "seed_path": str(seed_dir),
            "session_id": "../etc/passwd",
            "source_path": str(source_audio),
        },
    )
    assert res.status_code == 422  # pydantic pattern violation
