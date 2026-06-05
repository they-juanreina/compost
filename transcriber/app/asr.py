"""ASR wrapper (#10): Whisper-large-v3 with event-tag tokens via WhisperX.

The heavy model (whisperx / faster-whisper / torch) is imported lazily so the
service, the cue parser, and the test suite all work without the multi-GB
weights installed. Install the `asr` extra and run inside the OrbStack
container for real transcription:

    pip install -e '.[asr]'

`transcribe()` returns word-aligned utterances whose text may contain event
tags; cue_parser.parse_transcript_cues() then lifts those into cues[].
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Protocol


@dataclass
class ASRConfig:
    model_name: str = "large-v3"
    device: str = "auto"  # "cpu" | "cuda" | "mps" | "auto"
    compute_type: str = "int8"
    language: str | None = None
    event_tags: bool = True
    engine: str = "whisper"  # "whisper" (WhisperX, Docker/CPU) | "parakeet" (parakeet-mlx, native Metal)


@dataclass
class ASRResult:
    utterances: list[dict[str, Any]] = field(default_factory=list)
    language: str | None = None
    model: str = ""


class WhisperBackend(Protocol):
    """Minimal surface the ASR wrapper needs. The real WhisperX backend
    implements this; tests provide a fake."""

    def transcribe(self, audio_path: str) -> dict[str, Any]: ...


def build_whisperx_transcribe_kwargs(language: str | None) -> dict[str, Any]:
    """Build the per-call kwargs for `whisperx.Model.transcribe()` so the
    configured language hint reaches transcribe, not just load_model (#180).

    Pre-fix, the hint was only passed to ``whisperx.load_model``; ``transcribe``
    re-ran auto-detect per file, so the request-level ``"language":"en"`` was
    effectively ignored. Tests the pure mapping without needing whisperx weights.
    """
    kwargs: dict[str, Any] = {"batch_size": 16}
    if language:
        kwargs["language"] = language
    return kwargs


class WhisperXBackend:  # pragma: no cover - needs multi-GB weights
    """Concrete WhisperBackend wrapping `whisperx`.

    Imports `whisperx` and `torch` lazily inside `__init__` so this module
    remains importable in environments without the [asr] extra installed.
    The constructor loads the model (multi-GB) the first time only — the
    `_load_whisperx_backend` lru_cache ensures one instance per (model, device,
    compute_type) tuple per process.
    """

    def __init__(self, config: ASRConfig):
        try:
            import torch  # type: ignore
            import whisperx  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "whisperx is not installed. Install the asr extra: pip install -e '.[asr]'"
            ) from e

        device = _resolve_device(config.device)
        self._model = whisperx.load_model(
            config.model_name,
            device=device,
            compute_type=config.compute_type,
            language=config.language,
            asr_options={"suppress_numerals": False},
        )
        self._align_model = None
        self._align_metadata = None
        self._device = device
        self._whisperx = whisperx
        self._torch = torch
        # Pre-fix (#180): load_model() received the language hint but
        # model.transcribe() didn't — WhisperX re-ran auto-detect per file
        # ("No language specified, language will be detected ... (increases
        # inference time)"). Hold the configured language on the backend and
        # pass it through on every transcribe call so the hint actually skips
        # the per-file detection step.
        self._language = config.language

    def transcribe(self, audio_path: str) -> dict[str, Any]:
        audio = self._whisperx.load_audio(audio_path)
        # Forward the configured language so WhisperX skips per-file auto-detect.
        # When None, behavior is unchanged (auto-detect, then we use the result).
        result = self._model.transcribe(audio, **build_whisperx_transcribe_kwargs(self._language))
        language = result.get("language") or self._language or "en"

        # Lazy-load the alignment model on first use (depends on detected language).
        if self._align_model is None:
            self._align_model, self._align_metadata = self._whisperx.load_align_model(
                language_code=language, device=self._device
            )

        aligned = self._whisperx.align(
            result["segments"],
            self._align_model,
            self._align_metadata,
            audio,
            self._device,
            return_char_alignments=False,
        )
        return {"segments": aligned["segments"], "language": language}


def _resolve_device(requested: str) -> str:  # pragma: no cover - env-dependent
    """Map `auto` to the best available device. `cpu`/`cuda`/`mps` pass through."""
    if requested != "auto":
        return requested
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


@lru_cache(maxsize=1)
def _load_whisperx_backend(config_key: str) -> WhisperBackend:  # pragma: no cover - needs weights
    """Lazily construct the real WhisperX backend. Cached per process so the
    multi-GB model loads once (cold-start cached)."""
    # config_key encodes (model_name, device, compute_type); reconstruct.
    model_name, device, compute_type = config_key.split(":", 2)
    return WhisperXBackend(
        ASRConfig(model_name=model_name, device=device, compute_type=compute_type)
    )


class Transcriber:
    def __init__(self, config: ASRConfig | None = None, backend: WhisperBackend | None = None):
        self.config = config or ASRConfig()
        self._backend = backend

    def _get_backend(self) -> WhisperBackend:
        if self._backend is not None:
            return self._backend
        if self.config.engine == "parakeet":
            from .asr_parakeet import _load_parakeet_backend, resolve_parakeet_model

            return _load_parakeet_backend(
                resolve_parakeet_model(self.config.model_name), self.config.language
            )
        key = f"{self.config.model_name}:{self.config.device}:{self.config.compute_type}"
        return _load_whisperx_backend(key)

    def transcribe(self, audio_path: str) -> ASRResult:
        raw = self._get_backend().transcribe(audio_path)
        utterances = _normalize_segments(raw.get("segments", []))
        return ASRResult(
            utterances=utterances,
            language=raw.get("language", self.config.language),
            model=self.config.model_name,
        )


def _normalize_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert backend segments into compost utterance dicts (pre-diarization,
    pre-cue-extraction). Speaker ids are filled by the diarizer (#11)."""
    out: list[dict[str, Any]] = []
    for i, seg in enumerate(segments, start=1):
        words = [
            {"w": w["word"], "s": int(w["start"] * 1000), "e": int(w["end"] * 1000), "conf": w.get("score", 1.0)}
            for w in seg.get("words", [])
            if "start" in w and "end" in w
        ]
        out.append(
            {
                "id": f"U-{i:04d}",
                "speaker_id": seg.get("speaker", "S?"),
                "turn": i,
                "start_ms": int(seg["start"] * 1000),
                "end_ms": int(seg["end"] * 1000),
                "text": seg.get("text", "").strip(),
                "words": words,
            }
        )
    return out
