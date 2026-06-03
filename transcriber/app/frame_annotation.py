"""Optional frame annotation (#50).

A one-sentence description of a frame from a vision-capable model. Off by
default; opt in via config.toml `[frames] annotation = "claude" | "moondream2"`
(decision #72). The annotation is recorded as an AI-authored event on the frame
and surfaces as [draft] until a researcher endorses it.

The vision models are injected (the Claude path calls the Anthropic API with
the frame + linked utterance; the Moondream2 path is a lazy-loaded local model)
so the gate, prompt, and event shape are testable without weights.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol

PROMPT = (
    "In one sentence, describe what's visible in this interview frame that a "
    "researcher reviewing the session might find notable. If nothing is notable, "
    "return null."
)


class VisionModel(Protocol):
    def describe(self, frame_path: str, prompt: str, linked_text: str) -> str | None: ...


def build_prompt(linked_text: str) -> str:
    """The standard prompt + the linked utterance text for context."""
    if linked_text:
        return f'{PROMPT}\n\nThe speaker was saying: "{linked_text}"'
    return PROMPT


def annotate_frame(
    frame: dict[str, Any],
    linked_text: str,
    model: VisionModel,
    *,
    enabled: bool,
    actor_id: str,
) -> dict[str, Any] | None:
    """Return an AI-authored `create` event for the frame's annotation, or None
    when annotation is disabled or the model declines (nothing notable).

    `enabled` reflects the per-seed config gate; right-click "annotate this
    frame" passes enabled=True on demand even when the default is off.
    """
    if not enabled:
        return None
    description = model.describe(frame["path"], build_prompt(linked_text), linked_text)
    if description is None or not description.strip():
        return None
    return {
        "artifact_kind": "frame_annotation",
        "action": "create",
        "actor_type": "ai",
        "actor_id": actor_id,
        "model": actor_id,
        "payload": {
            "frame_id": frame["id"],
            "at_ms": frame["at_ms"],
            "annotation": description.strip(),
            "status": "draft",
        },
    }


def claude_vision(call: Callable[[str, str], str | None]) -> VisionModel:
    """Wrap an Anthropic vision call (frame_path, prompt) → text into a VisionModel."""

    class _Claude:
        def describe(self, frame_path: str, prompt: str, linked_text: str) -> str | None:
            return call(frame_path, prompt)

    return _Claude()
