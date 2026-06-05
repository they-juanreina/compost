"""Parakeet (NVIDIA NeMo TDT) ASR backend via `parakeet-mlx` — the native
Apple-Silicon (Metal) transcription path (#176).

Conforms to the `WhisperBackend` Protocol in `asr.py`: `transcribe()` returns
`{"segments": [...], "language": ...}` with per-word timestamps, so the rest of
the pipeline (diarization, cue parsing, silence typing, prosody) is
engine-agnostic and unchanged.

`parakeet-mlx` requires Apple Silicon + MLX and is imported lazily, so this
module stays importable (and the pure mapping helpers stay unit-testable)
without the hardware or the ~2.5 GB weights. The heavy backend itself is marked
`# pragma: no cover`, exactly like `WhisperXBackend`.

Why Parakeet-TDT 0.6B v3 by default: it tops the Open ASR Leaderboard's
convenient (local, Apple-Silicon, word-timestamped) tier — measured ~58.8x
realtime on an M1 Max vs ~1.3x for WhisperX in the CPU container — with native
frame-level word timestamps and 25-language (incl. Spanish) coverage.
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

from .asr import ASRConfig, WhisperBackend

# A tiny EN-vs-ES language heuristic for the native Parakeet path (#190).
# parakeet-mlx auto-detects internally but doesn't surface the detection in its
# AlignedResult, so without a `--language` hint the transcript previously
# recorded `language: "und"` (via `_detect_language`'s fallback). For a turnkey
# zero-config run we'd rather record something sensible. Counts function-word
# hits in the transcribed text; biased toward English when the signal is weak
# (the v3 model is English-first multilingual).
_ES_HEURISTIC_TOKENS = frozenset(
    {
        "que", "de", "la", "los", "las", "el", "en", "es", "no",
        "una", "por", "con", "para", "del", "como", "pero", "más",
    }
)
_EN_HEURISTIC_TOKENS = frozenset(
    {
        "the", "and", "of", "to", "in", "is", "for", "with",
        "on", "that", "this", "you", "are", "was", "but", "they",
    }
)
_WORD_RE = re.compile(r"[a-zA-Záéíóúñü]+")


def guess_lang_from_text(text: str) -> str:
    """Best-effort EN/ES guess for the Parakeet path when neither the model
    nor a `--language` hint reveal the language. Falls back to ``en`` when the
    text is empty or signal is too weak — never returns ``und`` (#190).
    """
    if not text:
        return "en"
    tokens = _WORD_RE.findall(text.lower())
    if not tokens:
        return "en"
    es = sum(1 for t in tokens if t in _ES_HEURISTIC_TOKENS)
    en = sum(1 for t in tokens if t in _EN_HEURISTIC_TOKENS)
    # Require a clear ES margin to flip — otherwise default to EN (v3 is EN-first).
    if es > max(en, 1) * 1.2:
        return "es"
    return "en"

# Multilingual v3 (English + 24 European languages incl. Spanish) is the default;
# v2 (`...-0.6b-v2`) is English-only with marginally better English WER.
DEFAULT_PARAKEET_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"

# parakeet-mlx loads the whole file into a single Metal buffer unless chunked: a
# 1-hour interview tries to allocate ~131 GB and blows past Metal's ~20 GB cap.
# Chunk at 2 minutes (parakeet stitches chunks via its default 15 s overlap +
# token timestamps) so arbitrarily long audio fits in memory. Tunable via env.
DEFAULT_CHUNK_DURATION_S = 120.0


def tokens_to_words(tokens: list[Any]) -> list[dict[str, Any]]:
    """Merge parakeet sub-word tokens into words.

    parakeet emits sub-word tokens where a word boundary is marked by a leading
    space (e.g. ``[" If", ... ," we"," me","as"]`` → ``["If","we","measure"]``).
    A token whose text starts with a space (or the first token) begins a new
    word; the rest extend the current one. Timestamps are in **seconds** (the
    pipeline's `_normalize_segments` converts to ms).
    """
    words: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for t in tokens:
        txt = getattr(t, "text", "")
        if cur is None or txt.startswith(" "):
            if cur is not None:
                words.append(cur)
            cur = {
                "word": txt,
                "start": float(t.start),
                "end": float(t.end),
                "score": float(getattr(t, "confidence", 1.0) or 1.0),
            }
        else:
            cur["word"] += txt
            cur["end"] = float(t.end)
    if cur is not None:
        words.append(cur)
    for w in words:
        w["word"] = w["word"].strip()
    return [w for w in words if w["word"]]


def result_to_segments(result: Any) -> list[dict[str, Any]]:
    """Map a parakeet-mlx ``AlignedResult`` (sentences → tokens) to the
    `WhisperBackend` segment shape: ``{start, end, text, words}`` (seconds)."""
    segments: list[dict[str, Any]] = []
    for sent in getattr(result, "sentences", None) or []:
        segments.append(
            {
                "start": float(sent.start),
                "end": float(sent.end),
                "text": (getattr(sent, "text", "") or "").strip(),
                "words": tokens_to_words(getattr(sent, "tokens", None) or []),
            }
        )
    return segments


def resolve_parakeet_model(model_name: str | None) -> str:
    """A whisper-style model name (the ASRConfig default) means 'use the Parakeet
    default'; an explicit parakeet id passes through."""
    if model_name and "parakeet" in model_name:
        return model_name
    return DEFAULT_PARAKEET_MODEL


class ParakeetMLXBackend:  # pragma: no cover - needs MLX + weights
    """Concrete `WhisperBackend` wrapping `parakeet-mlx` (Apple Silicon / Metal)."""

    def __init__(self, config: ASRConfig):
        import os

        try:
            import parakeet_mlx  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "parakeet-mlx is not installed (native Apple-Silicon ASR). "
                "Install it in the native transcriber venv: pip install parakeet-mlx"
            ) from e
        self._model = parakeet_mlx.from_pretrained(resolve_parakeet_model(config.model_name))
        self._language = config.language
        self._chunk_s = float(os.environ.get("COMPOST_PARAKEET_CHUNK_S", DEFAULT_CHUNK_DURATION_S))

    def transcribe(self, audio_path: str) -> dict[str, Any]:
        # chunk_duration keeps long files within Metal's buffer cap (see above).
        result = self._model.transcribe(audio_path, chunk_duration=self._chunk_s)
        segments = result_to_segments(result)
        # Language resolution priority (#190):
        #   1. Whatever parakeet-mlx surfaces on the result (future-proof — the
        #      API doesn't expose it today, but a future minor might).
        #   2. The configured `--language` hint, if any.
        #   3. A tiny EN/ES heuristic on the transcribed text — better than
        #      letting `_detect_language` fall back to "und" on the zero-config
        #      turnkey path.
        language = getattr(result, "language", None) or self._language
        if not language:
            full_text = " ".join((s.get("text") or "") for s in segments)
            language = guess_lang_from_text(full_text)
        return {"segments": segments, "language": language}


@lru_cache(maxsize=1)
def _load_parakeet_backend(model_id: str, language: str | None) -> WhisperBackend:  # pragma: no cover
    """Lazily construct + cache the Parakeet backend (one model load per process)."""
    return ParakeetMLXBackend(
        ASRConfig(model_name=model_id, language=language, engine="parakeet")
    )
