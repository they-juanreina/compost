"""Tests for pyannote diarization alignment (#11). Pure maths; fake backend."""

from __future__ import annotations

from app.diarization import (
    DIARIZATION_CONFIDENCE_FLOOR,
    Diarizer,
    Turn,
    align,
    assign_speaker,
    detect_overlaps,
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


def test_diarizer_with_injected_backend():
    class FakeDia:
        def diarize(self, audio_path: str):
            return [{"start_ms": 0, "end_ms": 5000, "speaker": "S1"}]

    turns = Diarizer(backend=FakeDia()).diarize("/fake.wav")
    assert turns == [Turn(0, 5000, "S1")]
