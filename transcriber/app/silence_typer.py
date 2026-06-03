"""Silence typer — heuristic post-processor that assigns a semantic type to each
first-class silence (> threshold) from the surrounding utterance context.

Types (ROADMAP § Descriptive transcription A):
  - after_question : the silence follows a moderator question
  - mid_utterance  : the silence sits inside one speaker's turn
  - thinking       : a pre-response pause that isn't clearly after a question
  - interruption   : the silence coincides with an overlap/turn-steal

Rules are versioned. Researchers can override any assignment downstream; an
override is recorded as a `researcher`-authored event in the provenance log
(see issue #12 / provenance writer #27).

CHANGELOG
  v1 (2026-06-03): initial rule set.
    - after_question: previous utterance is a moderator AND ends with '?'
      (or a leading inverted '¿' question), and abuts the silence start.
    - interruption: an overlap/interruption cue overlaps the silence window,
      OR previous and next utterances are different speakers and the previous
      did not end on sentence-final punctuation (cut off).
    - mid_utterance: previous and next utterances are the same speaker.
    - thinking: default.
"""

from __future__ import annotations

from typing import Any

RULES_VERSION = "1"

_SILENCE_TYPES = ("after_question", "mid_utterance", "thinking", "interruption")

# How close (ms) the previous utterance's end must be to the silence start for
# the silence to be considered "abutting" that utterance.
_ABUT_TOLERANCE_MS = 250

_SENTENCE_FINAL = (".", "!", "?", "…")


def _ends_question(text: str) -> bool:
    stripped = text.rstrip()
    if stripped.endswith("?"):
        return True
    # Spanish inverted question mark opening with no closing yet still reads as a question.
    return "¿" in stripped and "?" in stripped


def _ends_sentence_final(text: str) -> bool:
    stripped = text.rstrip()
    return stripped.endswith(_SENTENCE_FINAL)


def _speaker_type(speakers: list[dict[str, Any]], speaker_id: str | None) -> str | None:
    if speaker_id is None:
        return None
    for s in speakers:
        if s.get("id") == speaker_id:
            return s.get("type")
    return None


def _cue_overlaps(silence: dict[str, Any], cues: list[dict[str, Any]]) -> bool:
    s_start = silence["start_ms"]
    s_end = silence["end_ms"]
    for cue in cues:
        if cue.get("kind") not in ("overlap", "interruption"):
            continue
        # any temporal overlap between the cue and the silence window
        if cue["start_ms"] <= s_end and cue["end_ms"] >= s_start:
            return True
    return False


def type_silence(
    silence: dict[str, Any],
    prev_utt: dict[str, Any] | None,
    next_utt: dict[str, Any] | None,
    speakers: list[dict[str, Any]],
    cues: list[dict[str, Any]] | None = None,
) -> str:
    """Return one of the four silence types for a single silence."""
    cues = cues or []

    if _cue_overlaps(silence, cues):
        return "interruption"

    if prev_utt is not None:
        abuts = abs(silence["start_ms"] - prev_utt["end_ms"]) <= _ABUT_TOLERANCE_MS
        prev_type = _speaker_type(speakers, prev_utt.get("speaker_id"))
        if abuts and prev_type == "moderator" and _ends_question(prev_utt.get("text", "")):
            return "after_question"

    if (
        prev_utt is not None
        and next_utt is not None
        and prev_utt.get("speaker_id") == next_utt.get("speaker_id")
    ):
        return "mid_utterance"

    # Different speakers (or unknown) and the previous turn was cut off → interruption.
    if (
        prev_utt is not None
        and next_utt is not None
        and prev_utt.get("speaker_id") != next_utt.get("speaker_id")
        and not _ends_sentence_final(prev_utt.get("text", ""))
    ):
        return "interruption"

    return "thinking"


def _utterance_before(utterances: list[dict[str, Any]], at_ms: int) -> dict[str, Any] | None:
    candidate = None
    for u in utterances:
        if u["end_ms"] <= at_ms + _ABUT_TOLERANCE_MS and (
            candidate is None or u["end_ms"] > candidate["end_ms"]
        ):
            candidate = u
    return candidate


def _utterance_after(utterances: list[dict[str, Any]], at_ms: int) -> dict[str, Any] | None:
    candidate = None
    for u in utterances:
        if u["start_ms"] >= at_ms - _ABUT_TOLERANCE_MS and (
            candidate is None or u["start_ms"] < candidate["start_ms"]
        ):
            candidate = u
    return candidate


def type_all_silences(transcript: dict[str, Any]) -> dict[str, Any]:
    """Annotate every silence in a transcript dict with a `context` type.

    Mutates and returns the transcript. Idempotent. Fast: O(silences × utterances).
    """
    utterances = transcript.get("utterances", [])
    cues = transcript.get("cues", [])
    speakers = transcript.get("speakers", [])
    for silence in transcript.get("silences", []):
        prev_utt = _utterance_before(utterances, silence["start_ms"])
        next_utt = _utterance_after(utterances, silence["end_ms"])
        silence["context"] = type_silence(silence, prev_utt, next_utt, speakers, cues)
    return transcript
