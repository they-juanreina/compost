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


PYANNOTE_MODEL = "pyannote/speaker-diarization-3.1"


def _resolve_diar_device(requested: str) -> str:  # pragma: no cover - env-dependent
    """Map 'auto' to the best available device. On Apple Silicon that's MPS
    (Metal) — ~18x faster than CPU for pyannote with identical results on
    torch>=2.12. 'cpu'/'mps'/'cuda' pass through."""
    if requested != "auto":
        return requested
    try:
        import torch  # type: ignore

        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except ImportError:
        pass
    return "cpu"


class PyannoteBackend:  # pragma: no cover - needs gated weights + torch
    """Concrete DiarizationBackend wrapping pyannote-audio.

    The pipeline is loaded once per process. HuggingFace token comes from
    HUGGINGFACE_TOKEN or HF_TOKEN env vars (one must be set; the user must
    also have accepted the license at hf.co/pyannote/speaker-diarization-3.1).
    """

    def __init__(self, device: str | None = None) -> None:
        import os

        token = os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("HF_TOKEN")
        if not token:
            raise RuntimeError(
                "pyannote needs HUGGINGFACE_TOKEN to download the gated model. "
                "Set it in .env.local and accept the license at hf.co/pyannote/speaker-diarization-3.1."
            )
        try:
            import torch  # type: ignore
            import torchaudio  # type: ignore
            from pyannote.audio import Pipeline  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "pyannote.audio / torchaudio not installed. Install the asr extra: pip install -e '.[asr]'"
            ) from e

        resolved = _resolve_diar_device(
            device or os.environ.get("COMPOST_DIARIZATION_DEVICE", "auto")
        )
        # On Apple Silicon, MPS runs pyannote ~18x faster than CPU with identical
        # results (verified on torch>=2.12); enable CPU fallback for any op MPS
        # lacks so it can never error out mid-pipeline (#176).
        if resolved == "mps":
            os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

        self._pipeline = Pipeline.from_pretrained(PYANNOTE_MODEL, token=token)
        if resolved != "cpu":
            self._pipeline = self._pipeline.to(torch.device(resolved))
        self._device = resolved
        self._torchaudio = torchaudio

    def diarize(self, audio_path: str) -> list[dict[str, Any]]:
        # Preload audio in-memory with torchaudio so pyannote 4.x doesn't hit
        # torchcodec (which requires CUDA runtime libraries we don't ship in
        # the CPU-only container). This is the documented fallback path.
        waveform, sample_rate = self._torchaudio.load(audio_path)
        output = self._pipeline({"waveform": waveform, "sample_rate": sample_rate})
        # pyannote 4.x returns DiarizeOutput; 3.x returned the Annotation directly.
        # Support both by reading .speaker_diarization if present, else the object itself.
        diarization = getattr(output, "speaker_diarization", output)
        turns: list[dict[str, Any]] = []
        for segment, _, speaker in diarization.itertracks(yield_label=True):
            turns.append(
                {
                    "start_ms": int(segment.start * 1000),
                    "end_ms": int(segment.end * 1000),
                    "speaker": str(speaker),
                }
            )
        return turns


@lru_cache(maxsize=1)
def _load_pyannote(token_present: bool) -> DiarizationBackend:  # pragma: no cover - needs weights
    if not token_present:
        raise RuntimeError(
            "pyannote needs HUGGINGFACE_TOKEN to download the gated model. "
            "Set it in .env.local and accept the license at hf.co/pyannote/speaker-diarization-3.1."
        )
    return PyannoteBackend()


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
        if self._backend is not None:
            return self._backend
        import os

        token_present = bool(os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("HF_TOKEN"))
        return _load_pyannote(token_present)

    def diarize(self, audio_path: str) -> list[Turn]:
        raw = self._get_backend().diarize(audio_path)
        return [Turn(int(t["start_ms"]), int(t["end_ms"]), str(t["speaker"])) for t in raw]
