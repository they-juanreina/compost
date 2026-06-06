"""ASR smoke test (#185).

Exercises the heavy native ASR path end to end on a tiny fixture clip: runs the
same `app.transcribe_cli` entrypoint the CLI uses, then asserts the produced
transcript.json is a valid session with speakers and word-timestamped utterances.

The base CI job installs `[frames,legacy]` — NOT `[asr]` — so WhisperX/Parakeet
and pyannote are only validated here. Opt-in / scheduled (needs the [asr] extras,
model downloads, and a HuggingFace token for pyannote), so it never gates PRs.

Usage:
    python scripts/asr_smoke.py [--engine parakeet|whisper] [--fixture PATH]
Exit code 0 = pass, 1 = fail.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TRANSCRIBER_DIR = Path(__file__).resolve().parent.parent
DEFAULT_FIXTURE = TRANSCRIBER_DIR / "tests" / "fixtures" / "asr_smoke.wav"


def _fail(msg: str) -> int:
    print(f"ASR smoke FAILED: {msg}")
    return 1


def run_smoke(fixture: Path, engine: str) -> int:
    if not fixture.is_file():
        return _fail(f"fixture not found: {fixture}")

    with tempfile.TemporaryDirectory() as tmp:
        seed = Path(tmp)
        session_dir = seed / "sessions" / "SMOKE"
        session_dir.mkdir(parents=True)
        source = session_dir / f"source{fixture.suffix}"
        shutil.copyfile(fixture, source)

        cmd = [
            sys.executable,
            "-m",
            "app.transcribe_cli",
            "--seed-path",
            str(seed),
            "--session-id",
            "SMOKE",
            "--source-path",
            str(source),
            "--engine",
            engine,
        ]
        print(f"$ {' '.join(cmd)}")
        proc = subprocess.run(cmd, cwd=TRANSCRIBER_DIR, capture_output=True, text=True)
        sys.stdout.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        if proc.returncode != 0:
            return _fail(f"transcribe_cli exited {proc.returncode}")

        transcript_path = session_dir / "transcript.json"
        if not transcript_path.is_file():
            return _fail(f"no transcript.json at {transcript_path}")
        transcript = json.loads(transcript_path.read_text())

        if transcript.get("session_id") != "SMOKE":
            return _fail(f"unexpected session_id: {transcript.get('session_id')!r}")
        speakers = transcript.get("speakers") or []
        if not speakers:
            return _fail("no speakers in transcript")
        utterances = transcript.get("utterances") or []
        if not utterances:
            return _fail("no utterances — ASR produced nothing on the fixture")
        has_word_timings = any(
            isinstance(u.get("words"), list)
            and any("s" in w and "e" in w for w in u["words"])
            for u in utterances
        )
        if not has_word_timings:
            return _fail("no word-level timestamps in any utterance")

    print(
        f"ASR smoke PASSED: engine={engine}, "
        f"{len(speakers)} speaker(s), {len(utterances)} utterance(s)."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="asr_smoke")
    p.add_argument("--engine", default="parakeet", choices=["parakeet", "whisper"])
    p.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    args = p.parse_args(argv)
    return run_smoke(Path(args.fixture), args.engine)


if __name__ == "__main__":
    raise SystemExit(main())
