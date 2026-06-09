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
faster than CPU with identical results. pyannote's raw `SPEAKER_00/01/...`
cluster labels are normalized to the schema's `S0/S1/...` ids in the transcript;
renaming them to real names (`compost label --map S0=Juan,S1=P07`) is a separate
step (#177).

## Native setup (Apple Silicon)

You need a Python 3.11+ venv with the native deps, plus a HuggingFace token for
pyannote (a gated model).

Provision the managed venv once — this creates `~/.compost/transcriber-venv`
and installs the native deps (parakeet-mlx + pyannote + silero-vad + torchaudio + ffmpeg-python):

```sh
compost setup --provision-native      # downloads ~GB of ML wheels — a few minutes
```

You also need a **HuggingFace token** for pyannote (a gated model). Accept the
license on **both** gated repos first (the 3.1 pipeline pulls segmentation-3.0
at runtime), then store the token:

- <https://huggingface.co/pyannote/speaker-diarization-3.1>
- <https://huggingface.co/pyannote/segmentation-3.0>

```sh
compost secrets set HUGGINGFACE_TOKEN     # OS keychain (most secure); reads from stdin
# …or just export it for this shell:
export HUGGINGFACE_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
```

Compost resolves the token by precedence — env var > OS keychain >
`~/.compost/secrets.env` (0600). See
[SECURITY.md → Storing your tokens](../SECURITY.md#storing-your-tokens).

<details><summary>Manual alternative (build the venv yourself)</summary>

```sh
python3.11 -m venv ~/.compost/transcriber-venv
~/.compost/transcriber-venv/bin/pip install parakeet-mlx pyannote.audio silero-vad torchaudio ffmpeg-python
```
</details>

Then transcribe — native is selected automatically:

```sh
compost transcribe S001 --seed my-study
# → runtime: native, engine: parakeet
```

**Path resolution** (precedence): `--python` / `--transcriber-dir` flags →
`COMPOST_TRANSCRIBER_PYTHON` / `COMPOST_TRANSCRIBER_DIR` env →
`~/.compost/transcriber-venv` + the `transcriber/` source (auto-discovered from a
checkout, or from the copy bundled in the cli package on a global install). Set
`COMPOST_HOME` to move the managed venv. A global `npm i -g` install bundles the
transcriber source, so it resolves automatically; `COMPOST_TRANSCRIBER_DIR`
remains available to point at a working-tree copy instead.

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
