"""Transcription pipeline orchestrator (#v0.1-01).

Composes the already-tested deterministic stages into a single transcript.json:

    duration probe → VAD speech/silences → ASR → diarization align →
    cue parser → silence typer → prosody → final transcript

Each stage accepts injectable backends so the route, the worker, and the tests
all share one orchestration codepath. The route in `routes/transcribe.py`
provides real backends; tests pass fakes.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .asr import ASRConfig, Transcriber, WhisperBackend
from .cue_parser import parse_transcript_cues
from .diarization import DiarizationBackend, Diarizer, align
from .prosody import annotate_prosody
from .silence_typer import type_all_silences
from .vad import VAD, VADBackend, silences_to_schema, utterance_energies

SCHEMA_VERSION = "1.0"
DEFAULT_TRANSCRIBER_VERSION = "compost-transcriber@0.1.0"


@dataclass
class PipelineConfig:
    asr: ASRConfig
    transcriber_version: str = DEFAULT_TRANSCRIBER_VERSION
    asr_model_tag: str = "whisper-large-v3-turbo-event-tags"
    diarizer_tag: str = "pyannote-audio@3.3"
    vad_tag: str = "silero-vad@5.0"


@dataclass
class PipelineBackends:
    """Inject concrete or fake backends. Route wires real ones; tests inject fakes."""

    vad: VADBackend | None = None
    asr: WhisperBackend | None = None
    diarization: DiarizationBackend | None = None


def probe_duration_ms(source_path: str) -> int:
    """Return the duration of an audio/video file in milliseconds via ffprobe.

    Falls back to 0 if ffprobe is missing or the file is unreadable; the caller
    can decide whether to error or proceed (silence segmentation against
    duration=0 produces no trailing silence, which is fine).
    """
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                source_path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if result.returncode != 0:
            return 0
        return int(float(result.stdout.strip()) * 1000)
    except (FileNotFoundError, ValueError, subprocess.TimeoutExpired):
        return 0


def _speakers_from_utterances(utterances: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Distinct speakers seen in the utterances; first speaker tagged as moderator,
    the rest as participants (researcher overrides this in the UI for now).
    """
    seen: dict[str, dict[str, Any]] = {}
    for u in utterances:
        sid = u.get("speaker_id", "S?")
        if sid in seen:
            continue
        seen[sid] = {"id": sid, "name": sid, "type": "participant"}
    # First seen → moderator by convention. Researcher can override post-hoc.
    if seen:
        first = next(iter(seen))
        seen[first]["type"] = "moderator"
    return list(seen.values())


def _detect_language(asr_lang: str | None, configured: str | None) -> str:
    """Prefer ASR-detected, then configured hint, then 'und' (undetermined)."""
    if asr_lang:
        return asr_lang
    if configured:
        return configured
    return "und"


def run_pipeline(
    seed_path: str,
    session_id: str,
    source_path: str,
    config: PipelineConfig,
    backends: PipelineBackends,
) -> dict[str, Any]:
    """Run every stage and return the final transcript dict.

    Side-effect-free except for backends' own model loading. The route writes
    the result to disk separately so this function is testable as pure
    transformation given the backends.
    """
    if not Path(source_path).exists():
        raise FileNotFoundError(f"source not found: {source_path}")

    duration_ms = probe_duration_ms(source_path)

    # 1. VAD — speech segments (carry per-segment RMS energy) + first-class silences
    vad = VAD(backend=backends.vad)
    speech, silences = vad.segment(source_path, duration_ms)

    # 2. ASR — utterances with word timings, may contain event tags inline
    asr = Transcriber(config=config.asr, backend=backends.asr)
    asr_result = asr.transcribe(source_path)

    # 3. Initial transcript shell
    transcript: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "kind": "session",
        "session_id": session_id,
        "source": _relative_source(seed_path, source_path),
        "language": _detect_language(asr_result.language, config.asr.language),
        "duration_ms": duration_ms,
        "modality": _modality(source_path),
        "speakers": [],
        "utterances": asr_result.utterances,
        "silences": silences_to_schema(silences),
        "cues": [],
        "frames": [],
        "glossary_refs": [],
        # frame_capture / frame_annotation are omitted (not null): the schema
        # types provenance fields as strings and the convention is "absent when
        # not applicable". run_pipeline does no frame capture/annotation; those
        # stages (frames.py / frame_annotation.py) add their own provenance when
        # they run.
        "provenance": {
            "transcriber": config.transcriber_version,
            "asr_model": config.asr_model_tag,
            "diarizer": config.diarizer_tag,
            "audio_cues": f"{config.vad_tag} + whisper-events",
        },
    }

    # 4. Diarization — assign speaker_id per utterance + overlap cues
    diarizer = Diarizer(backend=backends.diarization)
    turns = diarizer.diarize(source_path)
    align(transcript, turns)

    # 5. Speakers list, derived from the diarized utterances
    transcript["speakers"] = _speakers_from_utterances(transcript["utterances"])

    # 6. Cue parser — strip [laughter]/[sigh]/etc from utterance text into cues[]
    parse_transcript_cues(transcript)

    # 7. Silence semantic typing (after_question / thinking / interruption / …)
    type_all_silences(transcript)

    # 8. Prosody hints per utterance (deterministic, cheap). Volume bucketing
    # needs the per-utterance VAD RMS energy signal mapped from the speech
    # segments; without it volume would default to "normal" for every utterance.
    energies = utterance_energies(speech, transcript["utterances"])
    annotate_prosody(transcript, energies)

    return transcript


def _relative_source(seed_path: str, source_path: str) -> str:
    """Return a seed-relative path for transcript.source if the source lives
    inside the seed; otherwise return the absolute path unchanged.
    """
    try:
        return str(Path(source_path).relative_to(Path(seed_path).parent))
    except ValueError:
        return source_path


def _modality(source_path: str) -> list[str]:
    """Coarse modality flag from file extension. Video files imply both audio
    and video tracks (the player will only render video if present).
    """
    ext = Path(source_path).suffix.lower()
    if ext in {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}:
        return ["audio", "video"]
    return ["audio"]


def write_transcript(seed_path: str, session_id: str, transcript: dict[str, Any]) -> str:
    """Write transcript.json to sessions/<session_id>/. Returns the path."""
    out_dir = Path(seed_path) / "sessions" / session_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "transcript.json"
    out_path.write_text(json.dumps(transcript, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return str(out_path)
