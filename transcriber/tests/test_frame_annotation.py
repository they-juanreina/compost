"""Tests for optional frame annotation (#50)."""

from __future__ import annotations

from app.frame_annotation import PROMPT, annotate_frame, build_prompt

FRAME = {"id": "FR-000018800", "at_ms": 18800, "path": "sessions/S001/frames/000018800.jpg"}


class FakeVision:
    def __init__(self, out):
        self.out = out

    def describe(self, frame_path, prompt, linked_text):
        return self.out


def test_build_prompt_includes_linked_text():
    p = build_prompt("no sé si confiar")
    assert PROMPT in p
    assert "no sé si confiar" in p


def test_disabled_by_default_returns_none():
    ev = annotate_frame(FRAME, "x", FakeVision("a description"), enabled=False, actor_id="anthropic:claude")
    assert ev is None


def test_enabled_emits_ai_draft_event():
    ev = annotate_frame(
        FRAME, "no sé si confiar", FakeVision("P07 looks down, no movement for ~3s."),
        enabled=True, actor_id="anthropic:claude",
    )
    assert ev is not None
    assert ev["actor_type"] == "ai"
    assert ev["artifact_kind"] == "frame_annotation"
    assert ev["payload"]["status"] == "draft"
    assert ev["payload"]["frame_id"] == "FR-000018800"
    assert "looks down" in ev["payload"]["annotation"]


def test_model_declines_when_nothing_notable():
    assert annotate_frame(FRAME, "x", FakeVision(None), enabled=True, actor_id="m") is None
    assert annotate_frame(FRAME, "x", FakeVision("   "), enabled=True, actor_id="m") is None
