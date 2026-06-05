"""Unit tests for the Parakeet ASR backend's pure mapping (#176).

The heavy `parakeet-mlx` model isn't exercised here (it needs Apple Silicon +
weights — same posture as WhisperX's `# pragma: no cover`). These cover the
deterministic token→word→segment mapping the pipeline depends on, plus the
Transcriber normalization path with a fake Parakeet-shaped backend.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.asr import ASRConfig, Transcriber
from app.asr_parakeet import (
    DEFAULT_PARAKEET_MODEL,
    resolve_parakeet_model,
    result_to_segments,
    tokens_to_words,
)


def _tok(text: str, start: float, end: float, conf: float = 0.9) -> SimpleNamespace:
    return SimpleNamespace(text=text, start=start, end=end, confidence=conf)


def test_tokens_to_words_merges_subword_tokens():
    # " If"," we"," me","as","ure" → ["If","we","measure"]; word spans its sub-tokens.
    tokens = [
        _tok(" If", 0.0, 0.2),
        _tok(" we", 0.3, 0.4),
        _tok(" me", 0.5, 0.6),
        _tok("as", 0.6, 0.7),
        _tok("ure", 0.7, 0.8),
    ]
    words = tokens_to_words(tokens)
    assert [w["word"] for w in words] == ["If", "we", "measure"]
    assert words[2]["start"] == 0.5
    assert words[2]["end"] == 0.8  # merged end of "me"+"as"+"ure"


def test_tokens_to_words_empty():
    assert tokens_to_words([]) == []


def test_result_to_segments_shape():
    sent = SimpleNamespace(
        text=" Hello world",
        start=1.0,
        end=2.5,
        tokens=[_tok(" Hello", 1.0, 1.4), _tok(" world", 1.5, 2.5)],
    )
    result = SimpleNamespace(text="Hello world", sentences=[sent])
    segs = result_to_segments(result)
    assert len(segs) == 1
    assert segs[0]["start"] == 1.0
    assert segs[0]["end"] == 2.5
    assert segs[0]["text"] == "Hello world"
    assert [w["word"] for w in segs[0]["words"]] == ["Hello", "world"]


def test_result_to_segments_handles_no_sentences():
    assert result_to_segments(SimpleNamespace(text="", sentences=None)) == []


def test_resolve_parakeet_model():
    # The whisper-style ASRConfig default → use the Parakeet default.
    assert resolve_parakeet_model("large-v3") == DEFAULT_PARAKEET_MODEL
    # An explicit parakeet id passes through.
    assert resolve_parakeet_model("mlx-community/parakeet-tdt-0.6b-v2").endswith("v2")
    assert resolve_parakeet_model(None) == DEFAULT_PARAKEET_MODEL


def test_transcriber_normalizes_parakeet_segments():
    """End-to-end through Transcriber with a fake Parakeet-shaped backend (no MLX):
    seconds→ms, U-id assignment, speaker left as 'S?' for the diarizer."""

    class FakeBackend:
        def transcribe(self, audio_path: str):
            sent = SimpleNamespace(
                text=" Show me access",
                start=0.0,
                end=1.2,
                tokens=[_tok(" Show", 0.0, 0.3), _tok(" me", 0.4, 0.6), _tok(" access", 0.7, 1.2)],
            )
            return {
                "segments": result_to_segments(SimpleNamespace(text="x", sentences=[sent])),
                "language": "en",
            }

    res = Transcriber(config=ASRConfig(engine="parakeet"), backend=FakeBackend()).transcribe("x.wav")
    assert res.language == "en"
    assert len(res.utterances) == 1
    u = res.utterances[0]
    assert u["id"] == "U-0001"
    assert u["speaker_id"] == "S?"  # diarizer fills this later
    assert u["start_ms"] == 0
    assert u["end_ms"] == 1200
    assert u["text"] == "Show me access"
    assert [w["w"] for w in u["words"]] == ["Show", "me", "access"]
