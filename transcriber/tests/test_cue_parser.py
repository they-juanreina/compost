"""Tests for the cue parser (#10) and ASR segment normalization."""

from __future__ import annotations

from app.asr import ASRConfig, Transcriber, _normalize_segments
from app.cue_parser import (
    DEFAULT_CONFIDENCE,
    parse_cues_from_utterance,
    parse_transcript_cues,
)


def _utt(text, words=None, speaker="S2", start=1000, end=4000):
    u = {"id": "U-0001", "speaker_id": speaker, "turn": 1, "start_ms": start, "end_ms": end, "text": text}
    if words is not None:
        u["words"] = words
    return u


def test_extracts_laughter_cue_and_cleans_text():
    cleaned, cues = parse_cues_from_utterance(_utt("eso fue gracioso [laughter] sí"))
    assert "[laughter]" not in cleaned
    assert cleaned == "eso fue gracioso sí"
    assert len(cues) == 1
    assert cues[0]["kind"] == "laughter"
    assert cues[0]["source"] == "audio"
    assert cues[0]["speaker_id"] == "S2"
    assert cues[0]["confidence"] == DEFAULT_CONFIDENCE


def test_maps_clear_throat_alias_to_taxonomy_kind():
    _, cues = parse_cues_from_utterance(_utt("[clear_throat] bueno"))
    assert cues[0]["kind"] == "throat-clear"


def test_uses_word_span_when_tag_is_a_word():
    words = [
        {"w": "ja", "s": 1000, "e": 1200},
        {"w": "[laughter]", "s": 1200, "e": 1800},
    ]
    _, cues = parse_cues_from_utterance(_utt("ja [laughter]", words=words))
    assert cues[0]["start_ms"] == 1200
    assert cues[0]["end_ms"] == 1800


def test_falls_back_to_utterance_span_without_word_match():
    _, cues = parse_cues_from_utterance(_utt("[sigh] no sé", start=5000, end=7000))
    assert cues[0]["start_ms"] == 5000
    assert cues[0]["end_ms"] == 7000


def test_ignores_unknown_bracketed_tokens():
    cleaned, cues = parse_cues_from_utterance(_utt("precio [USD] alto"))
    assert cues == []
    assert cleaned == "precio [USD] alto"


def test_parse_transcript_cues_appends_and_numbers_sequentially():
    transcript = {
        "cues": [],
        "utterances": [
            _utt("hola [laughter]"),
            {"id": "U-0002", "speaker_id": "S1", "turn": 2, "start_ms": 5000, "end_ms": 6000, "text": "[cough] ok"},
        ],
    }
    out = parse_transcript_cues(transcript)
    kinds = [c["kind"] for c in out["cues"]]
    assert kinds == ["laughter", "cough"]
    assert [c["id"] for c in out["cues"]] == ["CUE-001", "CUE-002"]
    assert out["utterances"][0]["text"] == "hola"
    assert out["utterances"][1]["text"] == "ok"


def test_normalize_segments_to_utterances():
    segments = [
        {
            "start": 1.0,
            "end": 3.0,
            "text": " hola mundo ",
            "speaker": "S1",
            "words": [
                {"word": "hola", "start": 1.0, "end": 1.5, "score": 0.99},
                {"word": "mundo", "start": 1.6, "end": 2.0, "score": 0.95},
            ],
        }
    ]
    utts = _normalize_segments(segments)
    assert utts[0]["start_ms"] == 1000
    assert utts[0]["end_ms"] == 3000
    assert utts[0]["text"] == "hola mundo"
    assert utts[0]["words"][0] == {"w": "hola", "s": 1000, "e": 1500, "conf": 0.99}


def test_transcriber_with_injected_fake_backend():
    class FakeBackend:
        def transcribe(self, audio_path: str):
            return {
                "language": "es",
                "segments": [
                    {"start": 0.0, "end": 2.0, "text": "qué tal [laughter]", "speaker": "S2", "words": []}
                ],
            }

    t = Transcriber(ASRConfig(event_tags=True), backend=FakeBackend())
    result = t.transcribe("/fake/audio.wav")
    assert result.language == "es"
    assert len(result.utterances) == 1
    # cue extraction is a separate step; raw text still carries the tag
    assert "[laughter]" in result.utterances[0]["text"]
