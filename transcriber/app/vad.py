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
    # Mean RMS energy over the segment's waveform (raw amplitude, ~0..1; speech
    # peaks well below 1.0). `None` when the backend doesn't report it — the
    # prosody stage then leaves volume at "normal" rather than guessing.
    energy: float | None = None

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


class VADBackend(Protocol):
    def speech_timestamps(self, audio_path: str) -> list[dict[str, Any]]:
        """Return speech segments as ``{"start_ms", "end_ms"}`` dicts, optionally
        with a float ``"energy"`` (mean RMS over the segment)."""
        ...


SILERO_SAMPLE_RATE = 16000


class SileroBackend:  # pragma: no cover - needs torch + weights
    """Concrete VADBackend wrapping silero-vad.

    The Silero v5 model is loaded once per process. Audio is decoded to a
    16 kHz mono waveform via the package's `read_audio` helper. Returns
    speech segment boundaries in milliseconds.
    """

    def __init__(self) -> None:
        try:
            from silero_vad import (  # type: ignore
                get_speech_timestamps,
                load_silero_vad,
                read_audio,
            )
        except ImportError as e:
            raise RuntimeError(
                "silero-vad is not installed. Install the asr extra: pip install -e '.[asr]'"
            ) from e

        self._model = load_silero_vad()
        self._read_audio = read_audio
        self._get_speech_timestamps = get_speech_timestamps

    def speech_timestamps(self, audio_path: str) -> list[dict[str, Any]]:
        wav = self._read_audio(audio_path, sampling_rate=SILERO_SAMPLE_RATE)
        raw = self._get_speech_timestamps(
            wav,
            self._model,
            sampling_rate=SILERO_SAMPLE_RATE,
            return_seconds=False,
        )
        # `raw` is a list of {start, end} in samples; convert to ms and compute
        # the mean RMS energy over each segment's waveform window (#9 → #13).
        # `wav` is a mono float tensor in [-1, 1]; RMS = sqrt(mean(x^2)).
        ms_per_sample = 1000 / SILERO_SAMPLE_RATE
        out: list[dict[str, Any]] = []
        for seg in raw:
            start_sample, end_sample = int(seg["start"]), int(seg["end"])
            window = wav[start_sample:end_sample]
            rms = float(window.pow(2).mean().sqrt()) if window.numel() else 0.0
            out.append(
                {
                    "start_ms": int(seg["start"] * ms_per_sample),
                    "end_ms": int(seg["end"] * ms_per_sample),
                    "energy": rms,
                }
            )
        return out


@lru_cache(maxsize=1)
def _load_silero() -> VADBackend:  # pragma: no cover - needs torch + weights
    try:
        import torch  # type: ignore  # noqa: F401
    except ImportError as e:
        raise RuntimeError(
            "torch/silero not installed. Install the asr extra: pip install -e '.[asr]'"
        ) from e
    return SileroBackend()


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


def utterance_energies(
    speech: list[Segment],
    utterances: list[dict[str, Any]],
) -> dict[str, float]:
    """Map utterance id → mean VAD RMS energy, normalized 0..1 across the session.

    Pure. Feeds ``prosody.annotate_prosody(transcript, energies=...)`` so the
    low|normal|high volume bucketing actually runs (without this signal volume
    defaults to "normal" for every utterance).

    Each utterance's raw energy is the overlap-duration-weighted mean RMS of the
    speech segments it spans; segments with no energy reading are ignored. Raw
    speech RMS peaks far below 1.0, so applying prosody's fixed 0.33/0.66 split
    to raw values would bucket everything as "low" — we normalize by the loudest
    utterance in the session so the split is meaningful and reproducible.
    Utterances with no overlapping energy-bearing segment are omitted, so the
    caller reports "normal" rather than guessing.

    TODO(#13): normalization is per-session (global max) and prosody's
    VOLUME_LOW/HIGH are global constants, so a soft speaker's loudest moment
    still reads quieter than a loud speaker's baseline. Per-speaker
    normalization (group by ``utterance["speaker_id"]`` and normalize within
    each speaker) would make the buckets speaker-relative. Out of scope here.
    """
    raw: dict[str, float] = {}
    for utt in utterances:
        uid = utt.get("id")
        if uid is None:
            continue
        u_start, u_end = utt.get("start_ms", 0), utt.get("end_ms", 0)
        weighted_sum = 0.0
        total_overlap = 0
        for seg in speech:
            if seg.energy is None:
                continue
            overlap = min(u_end, seg.end_ms) - max(u_start, seg.start_ms)
            if overlap <= 0:
                continue
            weighted_sum += seg.energy * overlap
            total_overlap += overlap
        if total_overlap > 0:
            raw[uid] = weighted_sum / total_overlap

    peak = max(raw.values(), default=0.0)
    if peak <= 0:
        return {}
    return {uid: value / peak for uid, value in raw.items()}


class VAD:
    def __init__(self, backend: VADBackend | None = None):
        self._backend = backend

    def _get_backend(self) -> VADBackend:
        return self._backend if self._backend is not None else _load_silero()

    def segment(self, audio_path: str, total_duration_ms: int) -> tuple[list[Segment], list[Segment]]:
        """Return (speech_segments, first_class_silences)."""
        raw = self._get_backend().speech_timestamps(audio_path)
        speech = [
            Segment(
                int(t["start_ms"]),
                int(t["end_ms"]),
                float(t["energy"]) if t.get("energy") is not None else None,
            )
            for t in raw
        ]
        silences = speech_to_silences(speech, total_duration_ms)
        return speech, silences
