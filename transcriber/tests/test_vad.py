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
