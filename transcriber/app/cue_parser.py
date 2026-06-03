"""Cue parser (#10).

Whisper-large-v3 with event-tag tokens emits inline markers like [laughter],
[sigh], [cough], [clear_throat], [unintelligible], and code-switching markers.
This module pulls those out of utterance text into structured cues[] entries
(schema/cues.taxonomy.json) and returns the cleaned text.

Pure and deterministic — no model. The ASR wrapper (asr.py) produces the
tagged text; this turns it into cues.
"""

from __future__ import annotations

import re
from typing import Any

# Whisper/Whisper-AT event tag → compost cue kind (cues.taxonomy.json).
TAG_TO_KIND: dict[str, str] = {
    "laughter": "laughter",
    "laugh": "laughter",
    "laughs": "laughter",
    "sigh": "sigh",
    "sighs": "sigh",
    "cough": "cough",
    "coughs": "cough",
    "clear_throat": "throat-clear",
    "throat_clear": "throat-clear",
    "throat-clear": "throat-clear",
    "unintelligible": "unintelligible",
    "inaudible": "unintelligible",
    "code_switch": "code-switching",
    "code-switch": "code-switching",
    "code_switching": "code-switching",
}

# Default confidence assigned to a tag-derived cue when the ASR gives none.
DEFAULT_CONFIDENCE = 0.8

_TAG_RE = re.compile(r"\[([a-zA-Z_\-]+)\]")


def _clean_text(text: str) -> str:
    # Drop recognized event tags, collapse the resulting double spaces.
    def repl(m: re.Match[str]) -> str:
        return "" if m.group(1).lower() in TAG_TO_KIND else m.group(0)

    return re.sub(r"\s{2,}", " ", _TAG_RE.sub(repl, text)).strip()


def parse_cues_from_utterance(
    utterance: dict[str, Any],
    next_cue_index: int = 1,
    confidence: float = DEFAULT_CONFIDENCE,
) -> tuple[str, list[dict[str, Any]]]:
    """Return (cleaned_text, cues) for one utterance.

    Cue timing: if a word in `words[]` matches the tag, use that word's span;
    otherwise fall back to the utterance span.
    """
    text = utterance.get("text", "")
    words = utterance.get("words", [])
    speaker_id = utterance.get("speaker_id")
    cues: list[dict[str, Any]] = []
    idx = next_cue_index

    for m in _TAG_RE.finditer(text):
        kind = TAG_TO_KIND.get(m.group(1).lower())
        if kind is None:
            continue
        start_ms, end_ms = _tag_span(m.group(0), words, utterance)
        cue: dict[str, Any] = {
            "id": f"CUE-{idx:03d}",
            "kind": kind,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "source": "audio",
            "confidence": confidence,
        }
        if speaker_id is not None:
            cue["speaker_id"] = speaker_id
        cues.append(cue)
        idx += 1

    return _clean_text(text), cues


def _tag_span(
    tag_token: str,
    words: list[dict[str, Any]],
    utterance: dict[str, Any],
) -> tuple[int, int]:
    for w in words:
        if w.get("w") == tag_token:
            return int(w["s"]), int(w["e"])
    return int(utterance["start_ms"]), int(utterance["end_ms"])


def parse_transcript_cues(transcript: dict[str, Any]) -> dict[str, Any]:
    """Extract cues from every utterance, append to cues[], strip tags from text.

    Cue ids continue from any existing cues[]. Mutates and returns the transcript.
    """
    existing = transcript.setdefault("cues", [])
    idx = len(existing) + 1
    for utt in transcript.get("utterances", []):
        cleaned, cues = parse_cues_from_utterance(utt, next_cue_index=idx)
        utt["text"] = cleaned
        existing.extend(cues)
        idx += len(cues)
    return transcript
