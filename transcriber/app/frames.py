"""ffmpeg-backed frame extractor (#14).

Pulls a JPG from the video stream at each requested trigger timestamp and
writes it to sessions/<sid>/frames/<padded_ms>.jpg (640x360). Returns the
frames[] index entries for transcript.json. No classification — frames are
evidence.

Triggers (see schema/frames.taxonomy.json): silence_*, audio_cue, shot_change,
highlight, manual, sampling. The caller supplies (at_ms, trigger,
linked_utterance_id?) tuples; this module just extracts + indexes.

Idempotent: a frame whose target JPG already exists is not re-extracted, and
the returned id is stable (FR-<padded_ms>).
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

FRAME_WIDTH = 640
FRAME_HEIGHT = 360
_PAD = 9  # zero-pad ms to 9 digits (~277h) for lexical sort


@dataclass(frozen=True)
class FrameTrigger:
    at_ms: int
    trigger: str
    linked_utterance_id: str | None = None


def _padded(ms: int) -> str:
    return str(ms).zfill(_PAD)


def frame_id(at_ms: int) -> str:
    return f"FR-{_padded(at_ms)}"


def frame_relpath(session_id: str, at_ms: int) -> str:
    return f"sessions/{session_id}/frames/{_padded(at_ms)}.jpg"


def _extract_one(video_path: Path, at_ms: int, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    ts = at_ms / 1000.0
    # -ss before -i seeks fast; -frames:v 1 grabs a single frame; scale to 640x360.
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{ts:.3f}",
        "-i",
        str(video_path),
        "-frames:v",
        "1",
        "-vf",
        f"scale={FRAME_WIDTH}:{FRAME_HEIGHT}",
        "-q:v",
        "4",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not out_path.exists():
        raise RuntimeError(f"ffmpeg failed extracting frame at {at_ms}ms: {proc.stderr[-300:]}")


def extract_frames(
    video_path: str | Path,
    session_id: str,
    triggers: list[FrameTrigger],
    seed_root: str | Path,
) -> list[dict[str, Any]]:
    """Extract a frame per trigger; return frames[] index entries.

    Deduplicates by at_ms (the first trigger for a given ms wins), and skips
    extraction when the JPG already exists (idempotent re-runs).
    """
    video_path = Path(video_path)
    seed_root = Path(seed_root)

    seen: dict[int, FrameTrigger] = {}
    for t in triggers:
        seen.setdefault(t.at_ms, t)

    frames: list[dict[str, Any]] = []
    for at_ms in sorted(seen):
        trig = seen[at_ms]
        rel = frame_relpath(session_id, at_ms)
        abs_path = seed_root / rel
        if not abs_path.exists():
            _extract_one(video_path, at_ms, abs_path)
        entry: dict[str, Any] = {
            "id": frame_id(at_ms),
            "at_ms": at_ms,
            "path": rel,
            "trigger": trig.trigger,
        }
        if trig.linked_utterance_id is not None:
            entry["linked_utterance_id"] = trig.linked_utterance_id
        frames.append(entry)
    return frames


def sampling_triggers(
    duration_ms: int,
    existing_ms: list[int],
    interval_s: int = 60,
) -> list[FrameTrigger]:
    """Emit a `sampling` trigger every `interval_s` only when no other trigger
    already fired within that window (ROADMAP § Descriptive transcription B).
    """
    interval_ms = interval_s * 1000
    existing = sorted(existing_ms)
    out: list[FrameTrigger] = []
    t = 0
    ei = 0
    while t < duration_ms:
        window_end = t + interval_ms
        # advance existing pointer past anything before this window
        while ei < len(existing) and existing[ei] < t:
            ei += 1
        covered = ei < len(existing) and existing[ei] < window_end
        if not covered:
            out.append(FrameTrigger(at_ms=t, trigger="sampling"))
        t = window_end
    return out
