"""pyannote-audio diarization + word-level alignment (#11).

The pyannote pipeline (gated model; needs HUGGINGFACE_TOKEN + torch) is loaded
lazily. The alignment maths — assigning a stable speaker_id to each utterance
by maximum temporal overlap with diarization turns, flagging overlap regions,
and gating low-confidence sessions — is pure and fully unit-tested.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol

# Below this mean per-utterance overlap confidence, the session is queued for
# human speaker labelling instead of trusted.
DIARIZATION_CONFIDENCE_FLOOR = 0.5


@dataclass(frozen=True)
class Turn:
    start_ms: int
    end_ms: int
    speaker: str


class DiarizationBackend(Protocol):
    def diarize(self, audio_path: str) -> list[dict[str, Any]]: ...


@lru_cache(maxsize=1)
def _load_pyannote(token_present: bool) -> DiarizationBackend:  # pragma: no cover - needs weights
    if not token_present:
        raise RuntimeError("pyannote needs HUGGINGFACE_TOKEN to download the gated model")
    try:
        import pyannote.audio  # type: ignore  # noqa: F401
    except ImportError as e:
        raise RuntimeError("pyannote not installed. Install the asr extra.") from e
    raise NotImplementedError("Real pyannote wiring runs in the container; tests inject a backend.")


def _overlap_ms(a_start: int, a_end: int, b_start: int, b_end: int) -> int:
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def assign_speaker(utterance: dict[str, Any], turns: list[Turn]) -> tuple[str, float]:
    """Return (speaker_id, confidence) for an utterance by max overlap.

    confidence = overlapped duration with the winning speaker / utterance
    duration (0..1). Ties resolve to the earlier-starting turn.
    """
    u_start = utterance["start_ms"]
    u_end = utterance["end_ms"]
    u_dur = max(u_end - u_start, 1)

    by_speaker: dict[str, int] = {}
    for t in turns:
        ov = _overlap_ms(u_start, u_end, t.start_ms, t.end_ms)
        if ov > 0:
            by_speaker[t.speaker] = by_speaker.get(t.speaker, 0) + ov

    if not by_speaker:
        return "S?", 0.0
    winner = max(by_speaker.items(), key=lambda kv: kv[1])
    return winner[0], min(winner[1] / u_dur, 1.0)


def detect_overlaps(turns: list[Turn], min_overlap_ms: int = 200) -> list[dict[str, Any]]:
    """Find regions where two turns overlap; emit `overlap` cues."""
    cues: list[dict[str, Any]] = []
    ordered = sorted(turns, key=lambda t: t.start_ms)
    idx = 1
    for i in range(len(ordered)):
        for j in range(i + 1, len(ordered)):
            a, b = ordered[i], ordered[j]
            if b.start_ms >= a.end_ms:
                break  # no later turn can overlap a (sorted by start)
            if a.speaker == b.speaker:
                continue
            ov_start = max(a.start_ms, b.start_ms)
            ov_end = min(a.end_ms, b.end_ms)
            if ov_end - ov_start >= min_overlap_ms:
                cues.append(
                    {
                        "id": f"CUE-OV-{idx:03d}",
                        "kind": "overlap",
                        "start_ms": ov_start,
                        "end_ms": ov_end,
                        "source": "audio",
                    }
                )
                idx += 1
    return cues


def align(transcript: dict[str, Any], turns: list[Turn]) -> dict[str, Any]:
    """Assign speaker_id + per-utterance diarization confidence, attach overlap
    cues, and set session status when mean confidence is below the floor.
    Mutates and returns the transcript.
    """
    confidences: list[float] = []
    for utt in transcript.get("utterances", []):
        speaker, conf = assign_speaker(utt, turns)
        utt["speaker_id"] = speaker
        utt.setdefault("diarization", {})["confidence"] = round(conf, 3)
        confidences.append(conf)

    cues = transcript.setdefault("cues", [])
    cues.extend(detect_overlaps(turns))

    mean_conf = sum(confidences) / len(confidences) if confidences else 0.0
    if mean_conf < DIARIZATION_CONFIDENCE_FLOOR:
        transcript["status"] = "needs_speaker_labels"
    return transcript


class Diarizer:
    def __init__(self, backend: DiarizationBackend | None = None):
        self._backend = backend

    def _get_backend(self) -> DiarizationBackend:
        return self._backend if self._backend is not None else _load_pyannote(False)

    def diarize(self, audio_path: str) -> list[Turn]:
        raw = self._get_backend().diarize(audio_path)
        return [Turn(int(t["start_ms"]), int(t["end_ms"]), str(t["speaker"])) for t in raw]
