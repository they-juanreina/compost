"""Perceptual-hash shot-change detector (#15).

Samples the video at a fixed cadence, computes a perceptual hash per sampled
frame, and reports the timestamps where the hash distance to the previous
sample crosses a threshold — i.e. a scene cut, slide change, or camera move.

Output is a list of at_ms values consumed by the frame extractor (#14) as
`shot_change` triggers. No classification beyond "something changed".
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import imagehash
from PIL import Image

# Default Hamming-distance threshold between consecutive perceptual hashes.
# Tunable via config ([frames].shot_change_phash_distance).
DEFAULT_PHASH_DISTANCE = 12
DEFAULT_SAMPLE_INTERVAL_MS = 1000


def _sample_frame(video_path: Path, at_ms: int, out_path: Path) -> bool:
    ts = at_ms / 1000.0
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
        "scale=160:90",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc.returncode == 0 and out_path.exists()


def detect_shot_changes(
    video_path: str | Path,
    duration_ms: int,
    threshold: int = DEFAULT_PHASH_DISTANCE,
    sample_interval_ms: int = DEFAULT_SAMPLE_INTERVAL_MS,
) -> list[int]:
    """Return at_ms timestamps where a shot change is detected.

    The first sampled frame is never a "change" (no predecessor). Distances at
    or above `threshold` mark a change.
    """
    video_path = Path(video_path)
    changes: list[int] = []
    prev_hash: imagehash.ImageHash | None = None

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        at = 0
        idx = 0
        while at < duration_ms:
            frame_path = tmp_dir / f"s{idx}.png"
            if _sample_frame(video_path, at, frame_path):
                with Image.open(frame_path) as img:
                    h = imagehash.phash(img)
                if prev_hash is not None and (h - prev_hash) >= threshold:
                    changes.append(at)
                prev_hash = h
            at += sample_interval_ms
            idx += 1
    return changes
