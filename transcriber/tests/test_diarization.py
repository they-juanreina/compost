"""Tests for pyannote diarization alignment (#11). Pure maths; fake backend."""

from __future__ import annotations

from app.diarization import (
    DIARIZATION_CONFIDENCE_FLOOR,
    Diarizer,
    Turn,
    align,
    assign_speaker,
    detect_overlaps,
    merge_subthreshold_speakers,
)


def _utt(uid, start, end):
    return {"id": uid, "start_ms": start, "end_ms": end, "text": "x"}


def test_assign_speaker_by_max_overlap():
    turns = [Turn(0, 5000, "S1"), Turn(5000, 10000, "S2")]
    spk, conf = assign_speaker(_utt("U1", 1000, 4000), turns)
    assert spk == "S1"
    assert conf == 1.0


def test_assign_speaker_partial_overlap_confidence():
    turns = [Turn(0, 3000, "S1"), Turn(3000, 6000, "S2")]
    # utterance 2000-4000: 1000ms with S1, 1000ms with S2 → tie by accumulation;
    # both 1000ms, max picks first inserted deterministically (S1)
    spk, conf = assign_speaker(_utt("U1", 2000, 4000), turns)
    assert spk in ("S1", "S2")
    assert abs(conf - 0.5) < 1e-9


def test_assign_speaker_no_overlap_returns_unknown():
    spk, conf = assign_speaker(_utt("U1", 10000, 11000), [Turn(0, 5000, "S1")])
    assert spk == "S?"
    assert conf == 0.0


def test_stable_speaker_ids_across_session():
    turns = [Turn(0, 5000, "S1"), Turn(5000, 10000, "S2"), Turn(10000, 15000, "S1")]
    transcript = {
        "utterances": [_utt("U1", 1000, 4000), _utt("U2", 6000, 9000), _utt("U3", 11000, 14000)],
    }
    align(transcript, turns)
    ids = [u["speaker_id"] for u in transcript["utterances"]]
    assert ids == ["S1", "S2", "S1"]  # S1 reused, no per-turn collision


def test_overlap_regions_emitted_as_cues():
    turns = [Turn(0, 5000, "S1"), Turn(4000, 8000, "S2")]  # overlap 4000-5000
    cues = detect_overlaps(turns)
    assert len(cues) == 1
    assert cues[0]["kind"] == "overlap"
    assert cues[0]["start_ms"] == 4000
    assert cues[0]["end_ms"] == 5000


def test_no_overlap_cue_for_same_speaker_or_tiny_overlap():
    assert detect_overlaps([Turn(0, 5000, "S1"), Turn(4900, 8000, "S1")]) == []  # same speaker
    assert detect_overlaps([Turn(0, 5000, "S1"), Turn(4950, 8000, "S2")]) == []  # 50ms < 200ms


def test_low_confidence_flags_needs_speaker_labels():
    # utterances barely overlap their turns → low mean confidence
    turns = [Turn(0, 1000, "S1")]
    transcript = {"utterances": [_utt("U1", 0, 10000)]}  # 1000/10000 = 0.1 conf
    align(transcript, turns)
    assert transcript["status"] == "needs_speaker_labels"


def test_high_confidence_does_not_flag():
    turns = [Turn(0, 10000, "S1")]
    transcript = {"utterances": [_utt("U1", 1000, 9000)]}
    align(transcript, turns)
    assert "status" not in transcript
    assert DIARIZATION_CONFIDENCE_FLOOR == 0.5


# ---------- #178: over-segmentation collapse + S? orphan rescue ----------


def test_merge_subthreshold_speakers_collapses_2party_overseg():
    # Real-world shape from #178: 2 dominant speakers (~85% / 10%) plus three
    # spurious slivers (3% / 1% / 1%) that are fragments of the dominant pair.
    turns = [
        Turn(0, 85_000, "S1"),       # 85% of 100s — dominant
        Turn(85_000, 88_000, "S3"),  # 3% — spurious sliver between S1 and S2
        Turn(88_000, 98_000, "S2"),  # 10% — dominant
        Turn(98_000, 99_000, "S4"),  # 1% — sliver after S2
        Turn(99_000, 100_000, "S5"), # 1% — sliver
    ]
    merged = merge_subthreshold_speakers(turns)
    speakers = {t.speaker for t in merged}
    assert speakers == {"S1", "S2"}, f"expected 2 dominant speakers, got {speakers}"
    # Each turn retains its original time range — only the label changes.
    assert [t.start_ms for t in merged] == [0, 85_000, 88_000, 98_000, 99_000]


def test_merge_subthreshold_speakers_picks_nearest_dominant_anchor():
    # Sliver between S1 and S2 — should attach to whichever is temporally closer.
    turns = [
        Turn(0, 10_000, "S1"),
        Turn(10_000, 10_500, "S3"),  # sliver — 0ms gap to S1, 0ms gap to next
        Turn(10_500, 100_000, "S2"),  # dominant
    ]
    merged = merge_subthreshold_speakers(turns)
    # Both gaps are 0 → ties resolve to prev (S1). Either is acceptable but
    # the chosen tie-break must be deterministic.
    assert merged[1].speaker == "S1"


def test_merge_subthreshold_speakers_unchanged_when_all_dominant():
    turns = [Turn(0, 5000, "S1"), Turn(5000, 10000, "S2"), Turn(10000, 15000, "S1")]
    assert merge_subthreshold_speakers(turns) == turns


def test_merge_subthreshold_speakers_handles_empty():
    assert merge_subthreshold_speakers([]) == []


def test_align_rescues_s_orphan_to_nearest_turn_speaker():
    # Utterance falls in a tiny gap between turn boundaries — pre-fix it became
    # an opaque "S?". Post-fix (#178) the nearest turn's speaker fills in.
    turns = [Turn(0, 5_000, "S1"), Turn(6_000, 12_000, "S2")]
    # Utterance 5_100-5_900 doesn't overlap either turn but is closer to S1's end.
    transcript = {"utterances": [_utt("U1", 5_100, 5_900)]}
    align(transcript, turns)
    assert transcript["utterances"][0]["speaker_id"] == "S1"
    # Confidence stays 0 — this is a fallback assignment, not a verified overlap.
    assert transcript["utterances"][0]["diarization"]["confidence"] == 0.0


def test_align_keeps_s_unknown_when_no_turns_at_all():
    # Defensive: if pyannote returned nothing, leave "S?" so the gate downstream
    # (needs_speaker_labels) can fire instead of silently guessing.
    transcript = {"utterances": [_utt("U1", 0, 1000)]}
    align(transcript, [])
    assert transcript["utterances"][0]["speaker_id"] == "S?"


def test_diarizer_applies_subthreshold_merge_on_backend_output():
    # End-to-end: the Diarizer wraps merge_subthreshold_speakers, so a backend
    # producing slivers yields only dominant speakers downstream.
    class FakeOverseg:
        def diarize(self, audio_path: str):
            return [
                {"start_ms": 0, "end_ms": 85_000, "speaker": "S1"},
                {"start_ms": 85_000, "end_ms": 87_000, "speaker": "S3"},
                {"start_ms": 87_000, "end_ms": 97_000, "speaker": "S2"},
                {"start_ms": 97_000, "end_ms": 98_000, "speaker": "S4"},
            ]

    turns = Diarizer(backend=FakeOverseg()).diarize("/fake.wav")
    speakers = {t.speaker for t in turns}
    assert speakers == {"S1", "S2"}


def test_diarizer_with_injected_backend():
    class FakeDia:
        def diarize(self, audio_path: str):
            return [{"start_ms": 0, "end_ms": 5000, "speaker": "S1"}]

    turns = Diarizer(backend=FakeDia()).diarize("/fake.wav")
    assert turns == [Turn(0, 5000, "S1")]
