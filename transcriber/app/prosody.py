"""Prosody hint extractor (#13).

Deterministic per-utterance hints derived from word timings, optional VAD
energy, and speech rate. No ML model — cheap, reproducible context.

Output shape (matches transcript.schema.json #/$defs/prosody):
    {"volume": "low|normal|high", "pace": "slow|normal|fast", "hesitations": int}

Thresholds are module constants, documented here for reproducibility:

  pace (words per second over the utterance span):
    < 2.0  → slow
    > 3.3  → fast
    else   → normal

  volume (mean VAD RMS energy, normalized 0..1; requires the energy signal
  from Silero VAD, issue #9). When energy is unavailable we report "normal"
  rather than guess:
    < 0.33 → low
    > 0.66 → high
    else   → normal

  hesitations = filler tokens + immediate word repetitions + long
  intra-utterance gaps (> 400 ms between consecutive words).
"""

from __future__ import annotations

import re
from typing import Any

PACE_SLOW_WPS = 2.0
PACE_FAST_WPS = 3.3
VOLUME_LOW = 0.33
VOLUME_HIGH = 0.66
HESITATION_GAP_MS = 400

# Multilingual (es-CO + en) filler set.
_FILLERS = {
    "uh",
    "um",
    "eh",
    "em",
    "este",
    "esto",
    "mmm",
    "hmm",
    "like",
    "pues",
}
_FILLER_PHRASES = ("o sea", "you know", "es decir")

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def _pace(text: str, start_ms: int, end_ms: int) -> str:
    duration_s = max((end_ms - start_ms) / 1000.0, 1e-6)
    n_words = len(_WORD_RE.findall(text))
    wps = n_words / duration_s
    if wps < PACE_SLOW_WPS:
        return "slow"
    if wps > PACE_FAST_WPS:
        return "fast"
    return "normal"


def _volume(energy: float | None) -> str:
    if energy is None:
        return "normal"
    if energy < VOLUME_LOW:
        return "low"
    if energy > VOLUME_HIGH:
        return "high"
    return "normal"


def _count_hesitations(text: str, words: list[dict[str, Any]] | None) -> int:
    count = 0
    tokens = [t.lower() for t in _WORD_RE.findall(text)]

    # filler single tokens
    count += sum(1 for t in tokens if t in _FILLERS)

    # filler phrases
    lowered = text.lower()
    for phrase in _FILLER_PHRASES:
        count += lowered.count(phrase)

    # immediate repetitions ("yo yo", "the the")
    for a, b in zip(tokens, tokens[1:], strict=False):
        if a == b and len(a) > 1:
            count += 1

    # long gaps between consecutive words
    if words:
        for prev, nxt in zip(words, words[1:], strict=False):
            if nxt.get("s", 0) - prev.get("e", 0) > HESITATION_GAP_MS:
                count += 1

    return count


def extract_prosody(utterance: dict[str, Any], energy: float | None = None) -> dict[str, Any]:
    """Compute {volume, pace, hesitations} for a single utterance dict."""
    text = utterance.get("text", "")
    return {
        "volume": _volume(energy),
        "pace": _pace(text, utterance["start_ms"], utterance["end_ms"]),
        "hesitations": _count_hesitations(text, utterance.get("words")),
    }


def annotate_prosody(
    transcript: dict[str, Any],
    energies: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Attach `prosody` to every utterance. `energies` maps utterance id → mean
    VAD RMS energy (0..1) when available. Mutates and returns the transcript.
    """
    energies = energies or {}
    for utt in transcript.get("utterances", []):
        utt["prosody"] = extract_prosody(utt, energies.get(utt.get("id")))
    return transcript
