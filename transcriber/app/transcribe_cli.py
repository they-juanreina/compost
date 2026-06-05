"""Native (host) transcription entrypoint (#176).

Runs the full pipeline ON THE HOST (no Docker) so Apple-Silicon ASR backends
(`parakeet-mlx` / Metal) and pyannote use the GPU/CPU directly — the Docker
container is CPU-only on macOS, which is the bottleneck this path removes. The
Node CLI shells out to this when `transcriber.runtime = native`; the Docker
`/transcribe` route stays the cross-platform fallback and shares the exact same
`run_pipeline` orchestration.

    python -m app.transcribe_cli \
        --seed-path <seed> --session-id S001 \
        --source-path <seed>/sessions/S001/source.mp3 \
        --engine parakeet --language en

Prints one JSON line mirroring the /transcribe response shape so the Node
caller parses both paths identically.
"""

from __future__ import annotations

import argparse
import json

from .asr import ASRConfig
from .pipeline import PipelineBackends, PipelineConfig, run_pipeline, write_transcript

_DEFAULT_MODEL = {
    "parakeet": "mlx-community/parakeet-tdt-0.6b-v3",
    "whisper": "large-v3-turbo",
}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="compost-transcribe-native")
    p.add_argument("--seed-path", required=True)
    p.add_argument("--session-id", required=True)
    p.add_argument("--source-path", required=True)
    p.add_argument("--engine", default="parakeet", choices=["parakeet", "whisper"])
    p.add_argument("--model", default=None, help="ASR model id (engine default if omitted)")
    p.add_argument("--language", default=None)
    p.add_argument("--device", default="auto")
    p.add_argument("--compute-type", default="int8")
    args = p.parse_args(argv)

    asr = ASRConfig(
        model_name=args.model or _DEFAULT_MODEL[args.engine],
        device=args.device,
        compute_type=args.compute_type,
        language=args.language,
        engine=args.engine,
    )
    config = PipelineConfig(asr=asr, asr_model_tag=f"{asr.model_name} ({args.engine})")

    try:
        transcript = run_pipeline(
            seed_path=args.seed_path,
            session_id=args.session_id,
            source_path=args.source_path,
            config=config,
            backends=PipelineBackends(),  # all None → real lazy backends (Silero / engine ASR / pyannote)
        )
    except Exception as e:  # surface as JSON so the Node caller can report it
        print(json.dumps({"status": "failed", "error": str(e)}))
        return 1

    path = write_transcript(args.seed_path, args.session_id, transcript)
    print(
        json.dumps(
            {
                "session_id": args.session_id,
                "transcript_path": path,
                "status": transcript.get("status", "ok"),
                "engine": args.engine,
                "model": asr.model_name,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
