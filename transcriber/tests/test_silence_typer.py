"""Tests for the silence typer (#12)."""

from __future__ import annotations

from app.silence_typer import RULES_VERSION, type_all_silences, type_silence

SPEAKERS = [
    {"id": "S1", "name": "Mod", "type": "moderator"},
    {"id": "S2", "name": "P07", "type": "participant"},
]


def _utt(uid, sid, start, end, text, turn=1):
    return {
        "id": uid,
        "speaker_id": sid,
        "turn": turn,
        "start_ms": start,
        "end_ms": end,
        "text": text,
    }


def _sil(start, end):
    return {"id": "SIL-1", "start_ms": start, "end_ms": end, "duration_ms": end - start}


def test_rules_version_pinned():
    assert RULES_VERSION == "1"


def test_after_question_when_moderator_asks_and_pause_follows():
    prev = _utt("U1", "S1", 0, 3000, "¿Cómo te sientes con las alertas?")
    nxt = _utt("U2", "S2", 7000, 9000, "Pues...")
    silence = _sil(3000, 7000)
    assert type_silence(silence, prev, nxt, SPEAKERS) == "after_question"


def test_not_after_question_when_participant_speaks():
    prev = _utt("U1", "S2", 0, 3000, "¿Será?")  # participant, not moderator
    nxt = _utt("U2", "S2", 5000, 6000, "no sé")
    silence = _sil(3000, 5000)
    assert type_silence(silence, prev, nxt, SPEAKERS) != "after_question"


def test_mid_utterance_same_speaker_both_sides():
    prev = _utt("U1", "S2", 0, 3000, "Estaba pensando")
    nxt = _utt("U2", "S2", 5000, 7000, "que tal vez sí")
    silence = _sil(3000, 5000)
    assert type_silence(silence, prev, nxt, SPEAKERS) == "mid_utterance"


def test_thinking_default_before_response():
    # participant pauses before answering a statement (not a question)
    prev = _utt("U1", "S1", 0, 3000, "Cuéntame de tu día.")
    nxt = _utt("U2", "S2", 6000, 8000, "Bueno")
    silence = _sil(3000, 6000)
    assert type_silence(silence, prev, nxt, SPEAKERS) == "thinking"


def test_interruption_from_overlap_cue():
    prev = _utt("U1", "S2", 0, 3000, "Yo creo que")
    nxt = _utt("U2", "S1", 3200, 4000, "perdón")
    silence = _sil(3000, 3200)
    cues = [{"kind": "overlap", "start_ms": 2900, "end_ms": 3100, "source": "audio"}]
    assert type_silence(silence, prev, nxt, SPEAKERS, cues) == "interruption"


def test_interruption_when_prev_cut_off_and_speaker_changes():
    prev = _utt("U1", "S2", 0, 3000, "Y entonces yo")  # no sentence-final punctuation
    nxt = _utt("U2", "S1", 3100, 4000, "Claro")
    silence = _sil(3000, 3100)
    assert type_silence(silence, prev, nxt, SPEAKERS) == "interruption"


def test_type_all_silences_annotates_in_place():
    transcript = {
        "speakers": SPEAKERS,
        "utterances": [
            _utt("U1", "S1", 0, 3000, "¿Confías en la alerta?"),
            _utt("U2", "S2", 7000, 9000, "No del todo."),
        ],
        "silences": [_sil(3000, 7000)],
        "cues": [],
    }
    out = type_all_silences(transcript)
    assert out["silences"][0]["context"] == "after_question"
    # idempotent
    again = type_all_silences(out)
    assert again["silences"][0]["context"] == "after_question"
