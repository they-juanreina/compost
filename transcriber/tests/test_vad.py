"""Tests for Silero VAD silence segmentation (#9).

The segmentation maths is pure; a fake VADBackend stands in for Silero so we
don't need torch/weights. The "three deliberate silences on a 10-min mp3"
acceptance check runs as a container integration step with the real model.
"""

from __future__ import annotations

from app.vad import (
    MIN_FIRST_CLASS_SILENCE_MS,
    VAD,
    Segment,
    silences_to_schema,
    speech_to_silences,
    utterance_energies,
)


def test_min_threshold_is_1500ms():
    assert MIN_FIRST_CLASS_SILENCE_MS == 1500


def test_three_long_silences_detected_between_speech():
    # speech blocks with three >2s gaps between them
    speech = [
        Segment(0, 5000),
        Segment(8000, 12000),  # gap 5000-8000 = 3000ms
        Segment(15000, 20000),  # gap 12000-15000 = 3000ms
        Segment(23000, 25000),  # gap 20000-23000 = 3000ms
    ]
    silences = speech_to_silences(speech, total_duration_ms=25000)
    assert len(silences) == 3
    assert [(s.start_ms, s.end_ms) for s in silences] == [
        (5000, 8000),
        (12000, 15000),
        (20000, 23000),
    ]


def test_short_gaps_are_not_first_class():
    speech = [
        Segment(0, 3000),
        Segment(3500, 6000),  # 500ms gap → not first-class
        Segment(6200, 9000),  # 200ms gap → not first-class
    ]
    silences = speech_to_silences(speech, total_duration_ms=9000)
    assert silences == []


def test_leading_and_trailing_silence_counted():
    speech = [Segment(2000, 5000)]
    silences = speech_to_silences(speech, total_duration_ms=8000)
    # leading 0-2000 (2000ms) and trailing 5000-8000 (3000ms)
    assert [(s.start_ms, s.end_ms) for s in silences] == [(0, 2000), (5000, 8000)]


def test_boundary_exactly_at_threshold_is_included():
    speech = [Segment(0, 1000), Segment(2500, 4000)]  # gap exactly 1500ms
    silences = speech_to_silences(speech, total_duration_ms=4000)
    assert len(silences) == 1
    assert silences[0].duration_ms == 1500


def test_overlapping_speech_segments_handled():
    speech = [Segment(0, 5000), Segment(3000, 9000)]  # overlap; cursor = max end
    silences = speech_to_silences(speech, total_duration_ms=12000)
    # only trailing 9000-12000 (3000ms)
    assert [(s.start_ms, s.end_ms) for s in silences] == [(9000, 12000)]


def test_silences_to_schema_shape():
    schema = silences_to_schema([Segment(5000, 8000)])
    assert schema[0]["id"] == "SIL-001"
    assert schema[0]["duration_ms"] == 3000
    assert schema[0]["context"] == "thinking"


def test_vad_with_injected_backend():
    class FakeVAD:
        def speech_timestamps(self, audio_path: str):
            return [{"start_ms": 0, "end_ms": 5000}, {"start_ms": 8000, "end_ms": 12000}]

    speech, silences = VAD(backend=FakeVAD()).segment("/fake.wav", total_duration_ms=12000)
    assert len(speech) == 2
    assert [(s.start_ms, s.end_ms) for s in silences] == [(5000, 8000)]
    # No "energy" key in the backend dicts → Segment.energy is None.
    assert all(s.energy is None for s in speech)


def test_vad_segment_carries_backend_energy():
    class FakeVAD:
        def speech_timestamps(self, audio_path: str):
            return [
                {"start_ms": 0, "end_ms": 5000, "energy": 0.04},
                {"start_ms": 8000, "end_ms": 12000, "energy": 0.20},
            ]

    speech, _ = VAD(backend=FakeVAD()).segment("/fake.wav", total_duration_ms=12000)
    assert [s.energy for s in speech] == [0.04, 0.20]


# --- utterance_energies (VAD segment energy → per-utterance, normalized) ----


def _utt(uid, start, end):
    return {"id": uid, "start_ms": start, "end_ms": end}


def test_utterance_energies_normalized_to_session_peak():
    # Each utterance fully overlaps one speech segment. Raw RMS values are small;
    # the helper normalizes by the loudest utterance so the peak becomes 1.0.
    speech = [
        Segment(0, 1000, energy=0.05),
        Segment(1000, 2000, energy=0.20),  # loudest
        Segment(2000, 3000, energy=0.10),
    ]
    utts = [_utt("U1", 0, 1000), _utt("U2", 1000, 2000), _utt("U3", 2000, 3000)]
    energies = utterance_energies(speech, utts)
    assert energies["U2"] == 1.0
    assert energies["U1"] == 0.05 / 0.20
    assert energies["U3"] == 0.10 / 0.20
    # Normalized values land in distinct prosody buckets (low / normal / high).
    assert energies["U1"] < 0.33 < energies["U3"] < 0.66 < energies["U2"]


def test_utterance_energies_overlap_weighted_mean():
    # One utterance spanning two segments of different loudness: energy is the
    # overlap-duration-weighted mean (here a 3:1 weighting toward the quiet one).
    speech = [Segment(0, 3000, energy=0.10), Segment(3000, 4000, energy=0.50)]
    utts = [_utt("U1", 0, 4000)]
    # raw = (0.10*3000 + 0.50*1000) / 4000 = 0.20; single utterance → peak == itself.
    assert utterance_energies(speech, utts) == {"U1": 1.0}


def test_utterance_energies_omits_utterances_without_overlap():
    speech = [Segment(0, 1000, energy=0.10)]
    utts = [_utt("U1", 0, 1000), _utt("U2", 5000, 6000)]  # U2 overlaps nothing
    energies = utterance_energies(speech, utts)
    assert "U2" not in energies
    assert energies["U1"] == 1.0


def test_utterance_energies_empty_when_no_energy_signal():
    # Segments without energy readings (e.g. a backend that doesn't report it)
    # yield no map → prosody falls back to "normal" for every utterance.
    speech = [Segment(0, 1000), Segment(1000, 2000)]
    utts = [_utt("U1", 0, 1000), _utt("U2", 1000, 2000)]
    assert utterance_energies(speech, utts) == {}
