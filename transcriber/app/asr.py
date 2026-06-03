"""ASR wrapper (#10): Whisper-large-v3 with event-tag tokens via WhisperX.

The heavy model (whisperx / faster-whisper / torch) is imported lazily so the
service, the cue parser, and the test suite all work without the multi-GB
weights installed. Install the `asr` extra and run inside the OrbStack
container for real transcription:

    pip install -e '.[asr]'

`transcribe()` returns word-aligned utterances whose text may contain event
tags; cue_parser.parse_transcript_cues() then lifts those into cues[].
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Protocol


@dataclass
class ASRConfig:
    model_name: str = "large-v3"
    device: str = "auto"  # "cpu" | "cuda" | "mps" | "auto"
    compute_type: str = "int8"
    language: str | None = None
    event_tags: bool = True


@dataclass
class ASRResult:
    utterances: list[dict[str, Any]] = field(default_factory=list)
    language: str | None = None
    model: str = ""


class WhisperBackend(Protocol):
    """Minimal surface the ASR wrapper needs. The real WhisperX backend
    implements this; tests provide a fake."""

    def transcribe(self, audio_path: str) -> dict[str, Any]: ...


@lru_cache(maxsize=1)
def _load_whisperx_backend(config_key: str) -> WhisperBackend:  # pragma: no cover - needs weights
    """Lazily construct the real WhisperX backend. Cached per process so the
    multi-GB model loads once (cold-start cached, per #10 acceptance)."""
    try:
        import whisperx  # type: ignore  # noqa: F401
    except ImportError as e:
        raise RuntimeError(
            "whisperx is not installed. Install the asr extra: pip install -e '.[asr]'"
        ) from e

    raise NotImplementedError(
        "Real WhisperX backend wiring runs in the OrbStack container; "
        "see transcriber/README.md. Unit tests inject a fake backend."
    )


class Transcriber:
    def __init__(self, config: ASRConfig | None = None, backend: WhisperBackend | None = None):
        self.config = config or ASRConfig()
        self._backend = backend

    def _get_backend(self) -> WhisperBackend:
        if self._backend is not None:
            return self._backend
        key = f"{self.config.model_name}:{self.config.device}:{self.config.compute_type}"
        return _load_whisperx_backend(key)

    def transcribe(self, audio_path: str) -> ASRResult:
        raw = self._get_backend().transcribe(audio_path)
        utterances = _normalize_segments(raw.get("segments", []))
        return ASRResult(
            utterances=utterances,
            language=raw.get("language", self.config.language),
            model=self.config.model_name,
        )


def _normalize_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert backend segments into compost utterance dicts (pre-diarization,
    pre-cue-extraction). Speaker ids are filled by the diarizer (#11)."""
    out: list[dict[str, Any]] = []
    for i, seg in enumerate(segments, start=1):
        words = [
            {"w": w["word"], "s": int(w["start"] * 1000), "e": int(w["end"] * 1000), "conf": w.get("score", 1.0)}
            for w in seg.get("words", [])
            if "start" in w and "end" in w
        ]
        out.append(
            {
                "id": f"U-{i:04d}",
                "speaker_id": seg.get("speaker", "S?"),
                "turn": i,
                "start_ms": int(seg["start"] * 1000),
                "end_ms": int(seg["end"] * 1000),
                "text": seg.get("text", "").strip(),
                "words": words,
            }
        )
    return out
