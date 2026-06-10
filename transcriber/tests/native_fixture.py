"""Deterministic builder for a realistic native-transcriber output fixture.

Drives the real ``run_pipeline`` (the exact orchestration the native CLI runs)
with fixed fake backends that mimic parakeet/whisper ASR + pyannote diarization,
including every shape that used to fail schema validation:

  * pyannote raw cluster labels (``SPEAKER_00`` / ``SPEAKER_01``) → normalized to S0/S1
  * an inter-speaker overlap → an ``overlap`` cue with a uniform ``CUE-NNN`` id
  * inline ``[laughter]`` / ``[sigh]`` event tags → tag-derived cues
  * a per-utterance ``diarization.confidence``
  * provenance with no null ``frame_capture`` / ``frame_annotation``

Shared by ``tests/test_transcript_schema.py`` (which schema-validates the output)
and ``scripts/export_transcript_fixture.py`` (which writes the committed fixture
the CLI's ``validateTranscript`` regression test consumes). Output is fully
deterministic — no Date/random, and ffprobe can't read the empty placeholder so
``duration_ms`` is backfilled — so a fresh build stays byte-identical to the
committed fixture.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from app.asr import ASRConfig
from app.pipeline import PipelineBackends, PipelineConfig, run_pipeline

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "native_transcript.json"


class _FakeVAD:
    """Quiet first segment, loud second → prosody buckets volume low/high."""

    def speech_timestamps(self, audio_path: str) -> list[dict[str, Any]]:
        return [
            {"start_ms": 1000, "end_ms": 5000, "energy": 0.04},
            {"start_ms": 9000, "end_ms": 14000, "energy": 0.20},
        ]


class _FakeASR:
    """Two utterances; each carries an inline event tag the cue parser lifts out."""

    def __init__(self, language: str = "es-CO") -> None:
        self._language = language

    def transcribe(self, audio_path: str) -> dict[str, Any]:
        return {
            "language": self._language,
            "segments": [
                {
                    "start": 1.0,
                    "end": 5.0,
                    "text": "¿Qué haces cuando entra una alerta automática? [laughter]",
                    "words": [
                        {"word": "¿Qué", "start": 1.0, "end": 1.3, "score": 0.99},
                        {"word": "haces", "start": 1.3, "end": 1.7, "score": 0.98},
                        {"word": "cuando", "start": 1.7, "end": 2.1, "score": 0.97},
                        {"word": "entra", "start": 2.1, "end": 2.5, "score": 0.96},
                    ],
                },
                {
                    "start": 9.0,
                    "end": 14.0,
                    "text": "[sigh] No sé si confiar; prefiero verificar manualmente.",
                    "words": [
                        {"word": "No", "start": 9.3, "end": 9.5, "score": 0.95},
                        {"word": "sé", "start": 9.5, "end": 9.7, "score": 0.94},
                        {"word": "si", "start": 9.7, "end": 9.9, "score": 0.93},
                        {"word": "confiar", "start": 9.9, "end": 10.6, "score": 0.92},
                    ],
                },
            ],
        }


class _FakeDiarization:
    """Raw pyannote labels. Default turns overlap (4.0–5.0s) → an overlap cue."""

    def __init__(self, turns: list[dict[str, Any]] | None = None) -> None:
        self._turns = turns

    def diarize(self, audio_path: str) -> list[dict[str, Any]]:
        if self._turns is not None:
            return self._turns
        return [
            {"start_ms": 1000, "end_ms": 5000, "speaker": "SPEAKER_00"},
            {"start_ms": 4000, "end_ms": 14000, "speaker": "SPEAKER_01"},
        ]


def _run(
    diar_turns: list[dict[str, Any]] | None = None, language: str = "es-CO"
) -> dict[str, Any]:
    asr = ASRConfig(
        model_name="mlx-community/parakeet-tdt-0.6b-v3",
        engine="parakeet",
        language=language,
    )
    config = PipelineConfig(
        asr=asr,
        asr_model_tag="mlx-community/parakeet-tdt-0.6b-v3 (parakeet)",
    )
    backends = PipelineBackends(
        vad=_FakeVAD(),
        asr=_FakeASR(language),
        diarization=_FakeDiarization(diar_turns),
    )
    with tempfile.TemporaryDirectory() as tmp:
        # Seed dir name + session id are fixed so _relative_source yields a
        # machine-independent transcript.source ("sample/sessions/S001/...").
        seed = Path(tmp) / "sample"
        session_dir = seed / "sessions" / "S001"
        session_dir.mkdir(parents=True)
        source = session_dir / "source.mp3"
        source.write_bytes(b"")  # placeholder; the fake ASR doesn't decode it
        return run_pipeline(
            seed_path=str(seed),
            session_id="S001",
            source_path=str(source),
            config=config,
            backends=backends,
        )


def _backfill_duration(transcript: dict[str, Any]) -> dict[str, Any]:
    # ffprobe can't read the empty placeholder, so probe_duration_ms returns 0.
    # Backfill a self-consistent duration (last event end + 1s) so the fixture
    # reads like a real session rather than a zero-length one. Deterministic.
    if transcript.get("duration_ms"):
        return transcript
    ends: list[int] = [u["end_ms"] for u in transcript.get("utterances", [])]
    ends += [s["end_ms"] for s in transcript.get("silences", [])]
    ends += [c["end_ms"] for c in transcript.get("cues", [])]
    transcript["duration_ms"] = (max(ends) + 1000) if ends else 0
    return transcript


def build_native_transcript() -> dict[str, Any]:
    """The canonical 'ok' native transcript fixture (deterministic)."""
    return _backfill_duration(_run())


def build_low_confidence_transcript() -> dict[str, Any]:
    """Variant where utterances barely overlap their turns → the diarizer sets
    ``status == "needs_speaker_labels"``. Exercises the optional top-level status.
    """
    turns = [
        {"start_ms": 1000, "end_ms": 1300, "speaker": "SPEAKER_00"},
        {"start_ms": 9000, "end_ms": 9300, "speaker": "SPEAKER_01"},
    ]
    return _backfill_duration(_run(diar_turns=turns))
