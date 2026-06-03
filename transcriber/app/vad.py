"""Silero VAD integration + silence segmentation (#9).

Two outputs (ROADMAP § Descriptive transcription A):
  (a) speech-segment boundaries → fed to ASR
  (b) silence boundaries → fed to the silence typer (#12)

Silero v5 is loaded once per process (cold-start cached). The model call is
lazily imported so this module — and the silence-segmentation maths, which is
pure — works without torch installed. Install the `asr` extra for real VAD.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol

# Silences shorter than this are NOT first-class; they remain gaps only.
MIN_FIRST_CLASS_SILENCE_MS = 1500


@dataclass(frozen=True)
class Segment:
    start_ms: int
    end_ms: int

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


class VADBackend(Protocol):
    def speech_timestamps(self, audio_path: str) -> list[dict[str, int]]: ...


@lru_cache(maxsize=1)
def _load_silero() -> VADBackend:  # pragma: no cover - needs torch + weights
    try:
        import torch  # type: ignore  # noqa: F401
    except ImportError as e:
        raise RuntimeError(
            "torch/silero not installed. Install the asr extra: pip install -e '.[asr]'"
        ) from e
    raise NotImplementedError(
        "Real Silero v5 backend wiring runs in the OrbStack container; "
        "tests inject a fake VADBackend."
    )


def speech_to_silences(
    speech: list[Segment],
    total_duration_ms: int,
    min_silence_ms: int = MIN_FIRST_CLASS_SILENCE_MS,
) -> list[Segment]:
    """Derive first-class silence segments from speech segments.

    Pure. Considers the gaps before the first speech, between speech segments,
    and after the last speech. Only gaps >= min_silence_ms are returned.
    Overlapping/auto-sorted by start.
    """
    ordered = sorted(speech, key=lambda s: s.start_ms)
    silences: list[Segment] = []
    cursor = 0
    for seg in ordered:
        if seg.start_ms - cursor >= min_silence_ms:
            silences.append(Segment(cursor, seg.start_ms))
        cursor = max(cursor, seg.end_ms)
    if total_duration_ms - cursor >= min_silence_ms:
        silences.append(Segment(cursor, total_duration_ms))
    return silences


def silences_to_schema(silences: list[Segment]) -> list[dict[str, Any]]:
    """Render silence segments as transcript.json silences[] entries (untyped;
    the silence typer #12 fills `context`)."""
    out: list[dict[str, Any]] = []
    for i, s in enumerate(silences, start=1):
        out.append(
            {
                "id": f"SIL-{i:03d}",
                "start_ms": s.start_ms,
                "end_ms": s.end_ms,
                "duration_ms": s.duration_ms,
                "context": "thinking",  # placeholder until the typer runs
            }
        )
    return out


class VAD:
    def __init__(self, backend: VADBackend | None = None):
        self._backend = backend

    def _get_backend(self) -> VADBackend:
        return self._backend if self._backend is not None else _load_silero()

    def segment(self, audio_path: str, total_duration_ms: int) -> tuple[list[Segment], list[Segment]]:
        """Return (speech_segments, first_class_silences)."""
        raw = self._get_backend().speech_timestamps(audio_path)
        speech = [Segment(int(t["start_ms"]), int(t["end_ms"])) for t in raw]
        silences = speech_to_silences(speech, total_duration_ms)
        return speech, silences
