# Transcription

Compost transcribes audio/video into a diarized, word-timestamped
`transcript.json` (the same shape regardless of how it's produced). There are
two runtimes:

| Runtime | Where it runs | Speed (M-series) | Use when |
|---|---|---|---|
| **native** (default on Apple Silicon) | host, Metal/MPS | **~16× realtime** (a 60-min interview in ~3.5 min) | you're on Apple Silicon |
| **docker** (cross-platform fallback) | Linux container, CPU | ~0.8× realtime (~60–77 min) | Linux / Windows / Intel Mac |

Both run the **same pipeline** (`run_pipeline`) and emit an **identical
`transcript.json`** — the runtime is a speed/portability choice, not a data
choice. `compost transcribe` auto-selects **native on Apple Silicon when it's
provisioned**, and falls back to Docker otherwise.

## Engines

- **Parakeet-TDT 0.6B v3** (default) — NVIDIA's transducer via `parakeet-mlx`,
  Metal-accelerated, native frame-level word timestamps, covers English +
  Spanish + 23 other European languages. Tops the convenient (local,
  word-timestamped) tier of the Open ASR Leaderboard.
- **Whisper large-v3-turbo** (`--engine whisper`) — for languages outside
  Parakeet's 25 (Whisper covers ~99), or as a long-audio cross-check.

Diarization is **pyannote** on **MPS (Metal)** for the native path — ~18–25×
faster than CPU with identical results. Speaker labels come back as
`SPEAKER_00/01/...` (rename is a separate step, #177).

## Native setup (Apple Silicon)

You need a Python 3.11+ venv with the native deps, plus a HuggingFace token for
pyannote (a gated model).

> `compost setup` will provision this automatically (tracked: **#183**). Until
> then, provision it once by hand at the path the CLI auto-discovers:

```sh
python3.11 -m venv ~/.compost/transcriber-venv
~/.compost/transcriber-venv/bin/pip install parakeet-mlx pyannote.audio silero-vad torchaudio

# HuggingFace token for pyannote — accept the license on BOTH gated repos first
# (the 3.1 pipeline pulls segmentation-3.0 at runtime):
#   https://huggingface.co/pyannote/speaker-diarization-3.1
#   https://huggingface.co/pyannote/segmentation-3.0
export HUGGINGFACE_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
```

Then transcribe — native is selected automatically:

```sh
compost transcribe S001 --seed my-study
# → runtime: native, engine: parakeet
```

**Path resolution** (precedence): `--python` / `--transcriber-dir` flags →
`COMPOST_TRANSCRIBER_PYTHON` / `COMPOST_TRANSCRIBER_DIR` env →
`~/.compost/transcriber-venv` + the repo's `transcriber/` (auto-discovered from
a checkout). Set `COMPOST_HOME` to move the managed venv. If you installed the
CLI globally (no repo checkout), set `COMPOST_TRANSCRIBER_DIR` to the
`transcriber/` package.

Tune with `--engine parakeet|whisper`, `--model <id>`, `--language <tag>`, and
`COMPOST_PARAKEET_CHUNK_S` (chunk seconds; default 120 — long files are chunked
to stay within Metal's buffer cap).

## Cross-platform fallback (Docker)

On Linux / Windows / Intel Mac (no Metal), use the Docker container. It runs
WhisperX + pyannote on CPU — slower, but produces the identical transcript.

```sh
docker compose -f transcriber/compose.yaml up --build -d
curl http://localhost:7862/health        # expect {"status":"ok",...}
compost transcribe S001 --seed my-study --runtime docker
```

First build downloads multi-GB model weights; subsequent runs are cached. The
container bind-mounts `../Seeds`, so seeds must live under the repo for the
Docker path (the native path has no such restriction).
