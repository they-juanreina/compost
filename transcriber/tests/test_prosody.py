"""Tests for the prosody extractor (#13)."""

from __future__ import annotations

from app.prosody import annotate_prosody, extract_prosody


def _utt(text, start, end, words=None):
    u = {"id": "U1", "start_ms": start, "end_ms": end, "text": text}
    if words is not None:
        u["words"] = words
    return u


def test_pace_slow_normal_fast():
    # 3 words in 3s = 1 wps → slow
    assert extract_prosody(_utt("uno dos tres", 0, 3000))["pace"] == "slow"
    # ~3 words/s → normal
    assert extract_prosody(_utt("uno dos tres", 0, 1000))["pace"] == "normal"
    # 8 words in 1s = 8 wps → fast
    assert extract_prosody(_utt("a b c d e f g h", 0, 1000))["pace"] == "fast"


def test_volume_from_energy_levels():
    assert extract_prosody(_utt("hola", 0, 1000), energy=0.1)["volume"] == "low"
    assert extract_prosody(_utt("hola", 0, 1000), energy=0.5)["volume"] == "normal"
    assert extract_prosody(_utt("hola", 0, 1000), energy=0.9)["volume"] == "high"


def test_volume_defaults_to_normal_without_energy():
    # Without the VAD energy signal (#9) we report normal rather than guess.
    assert extract_prosody(_utt("hola", 0, 1000))["volume"] == "normal"


def test_hesitations_count_fillers_and_phrases():
    p = extract_prosody(_utt("eh, pues, o sea, no sé", 0, 4000))
    # "eh" + "pues" fillers + "o sea" phrase = 3
    assert p["hesitations"] >= 3


def test_hesitations_count_repetitions():
    p = extract_prosody(_utt("yo yo creo que sí", 0, 3000))
    assert p["hesitations"] >= 1


def test_hesitations_count_long_gaps():
    words = [
        {"w": "yo", "s": 0, "e": 300},
        {"w": "creo", "s": 1200, "e": 1500},  # 900ms gap > 400ms
    ]
    p = extract_prosody(_utt("yo creo", 0, 1500, words=words))
    assert p["hesitations"] >= 1


def test_deterministic_repeated_calls():
    u = _utt("uno dos tres", 0, 2000)
    assert extract_prosody(u) == extract_prosody(u)


def test_annotate_prosody_attaches_to_every_utterance():
    transcript = {
        "utterances": [
            _utt("uno dos tres cuatro", 0, 1000),
            _utt("cinco", 2000, 5000),
        ],
    }
    out = annotate_prosody(transcript, energies={"U1": 0.9})
    assert all("prosody" in u for u in out["utterances"])
    assert set(out["utterances"][0]["prosody"]) == {"volume", "pace", "hesitations"}
