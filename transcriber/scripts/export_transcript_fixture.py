"""Regenerate the committed native-transcriber output fixture.

The fixture (``transcriber/tests/fixtures/native_transcript.json``) is a
realistic, deterministic ``run_pipeline`` output consumed by two regression
guards — the Python schema guard (``tests/test_transcript_schema.py``) and the
CLI's ``validateTranscript`` test (``cli/src/lib/validate.transcriber.test.ts``).
Run after any change to the transcript assembly that alters the output shape:

    python scripts/export_transcript_fixture.py

``tests/test_transcript_schema.py::test_committed_fixture_is_in_sync`` fails if
the committed file drifts from a fresh build, pointing back here.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Allow `python scripts/export_transcript_fixture.py` from the transcriber dir to
# import the `app` and `tests` packages (mirrors how the test suite resolves them).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests.native_fixture import FIXTURE_PATH, build_native_transcript  # noqa: E402


def main() -> int:
    transcript = build_native_transcript()
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(
        json.dumps(transcript, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    sys.stderr.write(f"wrote {FIXTURE_PATH}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
