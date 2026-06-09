"""pyannote-audio diarization + word-level alignment (#11).

The pyannote pipeline (gated model; needs HUGGINGFACE_TOKEN + torch) is loaded
lazily. The alignment maths — assigning a stable speaker_id to each utterance
by maximum temporal overlap with diarization turns, flagging overlap regions,
and gating low-confidence sessions — is pure and fully unit-tested.
"""

from __future__ import annotations

import re
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


# Speakers below this share of total speech are treated as over-segmentation
# fragments and merged into the nearest dominant cluster (#178). pyannote 3.1
# routinely splits a clean 2-party interview into 5–6 speakers (~85% / 10% +
# three 1–3% slivers); the slivers are temporal fragments of the dominant
# pair, not extra speakers.
DEFAULT_MIN_SPEAKER_SHARE = 0.05


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


_PYANNOTE_LABEL_RE = re.compile(r"^SPEAKER_(\d+)$")


def normalize_speaker_label(label: str) -> str:
    """Canonicalize a diarization speaker label to the schema's ``^S[0-9]+$`` form.

    pyannote emits cluster labels like ``SPEAKER_00`` / ``SPEAKER_01``; the
    transcript schema (schema/transcript.schema.json $defs.speaker.id and
    $defs.utterance.speaker_id) requires ``S{n}`` — e.g. ``S0``, ``S1``. Leading
    zeros are dropped (``SPEAKER_00`` → ``S0``). Already-canonical labels
    (``S1``) and the ``S?`` orphan sentinel pass through unchanged, so this is
    idempotent and safe to apply at the single write point in ``align()``.
    """
    m = _PYANNOTE_LABEL_RE.match(label)
    return f"S{int(m.group(1))}" if m else label


def _overlap_ms(a_start: int, a_end: int, b_start: int, b_end: int) -> int:
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def merge_subthreshold_speakers(
    turns: list[Turn], min_share: float = DEFAULT_MIN_SPEAKER_SHARE
) -> list[Turn]:
    """Collapse speakers with sub-threshold airtime into the nearest dominant
    cluster (#178). Pure transformation; safe to skip when nothing's spurious.

    A 60-min 2-party interview routinely diarizes as 6 speakers (~85% / 10%
    + three 1–3% slivers). The slivers are temporal fragments of the real
    pair, not extra speakers — reassign each sliver-turn to whichever
    dominant speaker is temporally closest (gap to the nearest dominant
    turn before vs after).

    Conservative: when every speaker meets the threshold the input is
    returned unchanged, and when no speaker meets the threshold (degenerate)
    the input is also returned unchanged rather than zeroing the speaker set.
    """
    if not turns:
        return turns
    total = sum(t.end_ms - t.start_ms for t in turns)
    if total <= 0:
        return turns
    by_speaker: dict[str, int] = {}
    for t in turns:
        by_speaker[t.speaker] = by_speaker.get(t.speaker, 0) + (t.end_ms - t.start_ms)
    dominant = {s for s, dur in by_speaker.items() if dur / total >= min_share}
    if not dominant or len(dominant) == len(by_speaker):
        return turns
    ordered = sorted(turns, key=lambda t: t.start_ms)
    out: list[Turn] = []
    for i, t in enumerate(ordered):
        if t.speaker in dominant:
            out.append(t)
            continue
        prev_dom = next((o for o in reversed(ordered[:i]) if o.speaker in dominant), None)
        next_dom = next((o for o in ordered[i + 1 :] if o.speaker in dominant), None)
        if prev_dom is None and next_dom is None:
            out.append(t)  # no anchor — leave as-is rather than guess
            continue
        if prev_dom is None:
            chosen = next_dom.speaker  # type: ignore[union-attr]
        elif next_dom is None:
            chosen = prev_dom.speaker
        else:
            gap_prev = t.start_ms - prev_dom.end_ms
            gap_next = next_dom.start_ms - t.end_ms
            chosen = prev_dom.speaker if gap_prev <= gap_next else next_dom.speaker
        out.append(Turn(t.start_ms, t.end_ms, chosen))
    return out


def _nearest_turn_speaker(utt_start_ms: int, utt_end_ms: int, turns: list[Turn]) -> str | None:
    """Pick the speaker of the turn whose nearest edge is closest to the
    utterance's midpoint (#178). Used to rescue 'S?' orphans — utterances
    whose timing didn't overlap any diarization turn (a few-ms sliver
    between turn boundaries). Returns None if turns is empty.
    """
    if not turns:
        return None
    mid = (utt_start_ms + utt_end_ms) // 2
    return min(
        turns,
        key=lambda t: min(abs(t.start_ms - mid), abs(t.end_ms - mid)),
    ).speaker


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


def detect_overlaps(
    turns: list[Turn], min_overlap_ms: int = 200, start_index: int = 1
) -> list[dict[str, Any]]:
    """Find regions where two turns overlap; emit `overlap` cues.

    Cue ids use the schema's uniform ``CUE-[0-9]{3,}`` space (the cue ``kind``
    already distinguishes overlap cues from ASR-tag cues, so a typed ``CUE-OV-``
    prefix would both duplicate that and violate the id pattern). ``start_index``
    lets the caller continue numbering past any cues already in cues[] so the
    overlap and tag-derived cues share one collision-free id sequence.
    """
    cues: list[dict[str, Any]] = []
    ordered = sorted(turns, key=lambda t: t.start_ms)
    idx = start_index
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
                        "id": f"CUE-{idx:03d}",
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

    Post-fix (#178): an utterance whose timing doesn't overlap any diarization
    turn (an "S?" orphan, e.g. a sliver between turn boundaries) is rescued by
    attaching the nearest turn's speaker. The confidence stays 0.0 to mark the
    assignment as a fallback rather than a verified overlap — those still
    accumulate against the mean-confidence floor and can trigger the
    needs_speaker_labels gate when there are many.
    """
    confidences: list[float] = []
    for utt in transcript.get("utterances", []):
        speaker, conf = assign_speaker(utt, turns)
        if speaker == "S?":
            rescued = _nearest_turn_speaker(utt["start_ms"], utt["end_ms"], turns)
            if rescued is not None:
                speaker = rescued  # confidence stays 0.0 (fallback marker)
        # Canonicalize pyannote's SPEAKER_NN labels to the schema's S{n} form at
        # the single write point so speakers[].id (derived from these) and every
        # utterances[].speaker_id agree with ^S[0-9]+$.
        utt["speaker_id"] = normalize_speaker_label(speaker)
        utt.setdefault("diarization", {})["confidence"] = round(conf, 3)
        confidences.append(conf)

    cues = transcript.setdefault("cues", [])
    cues.extend(detect_overlaps(turns, start_index=len(cues) + 1))

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
        turns = [Turn(int(t["start_ms"]), int(t["end_ms"]), str(t["speaker"])) for t in raw]
        # Collapse over-segmentation slivers into the dominant cluster (#178)
        # before align() and detect_overlaps() consume the turns.
        return merge_subthreshold_speakers(turns)
