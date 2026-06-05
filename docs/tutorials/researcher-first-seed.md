# Tutorial: a researcher's first seed (≈30 min)

End-to-end: ingest → transcribe → highlight → code → synthesize → export.
Runnable against the sample seed (`compost init sample --from-sample`) or your
own recordings.

## 0. Prerequisites

- compost installed (`pnpm add -g @they-juanreina/compost-cli`)
- Transcription: on Apple Silicon, the native venv (see [transcription.md](../transcription.md)); on other platforms, OrbStack running the Docker fallback (`docker compose -f transcriber/compose.yaml up -d`)
- Ollama with the default models (`ollama pull bge-m3 && ollama pull llama3.1:8b`)

## 1. Create a seed

```sh
compost init data-hub
```

This scaffolds `Seeds/data-hub/` (plan, sessions, glossary, highlights,
codebook, synthesis, exports, legacy) and `.compost/` (config.toml, AGENTS.md,
the SQLite stores). Open `.compost/config.toml` to set providers and the frame
profile (defaults: balanced frames, AI annotation off — decisions #72/#73).

## 2. Ingest

Drop recordings and legacy artifacts into `sessions/_inbox/`, then:

```sh
compost watch --seed data-hub          # or: compost ingest <path> --seed data-hub
```

The ingest-watcher assigns session ids and moves files to
`sessions/<sid>/source.<ext>`; the transcribe-worker produces
`transcript.json` (typed silences, audio cues, prosody, frames) and a
`transcript.md` mirror. Check progress: `compost status --seed data-hub`.

## 3. Highlight + code

In the web UI (`compost serve`) drag to highlight; from the CLI/agent, the
cross-session-similarity scanner proposes codes:

```sh
compost rescan --seed data-hub         # clusters un-coded highlights → AI code drafts
```

AI suggestions surface as `[draft]` until you endorse them — `compost blame`
shows the full lineage.

## 4. Synthesize

```sh
compost synthesize --seed data-hub --kind themes
```

Saturation pulses tell you when to stop collecting; journey-map drafts pull
from your coded data.

## 5. Export

```sh
compost export Seeds/data-hub/sessions/S001/transcript.json --format csv  --out out.csv
compost export Seeds/data-hub/sessions/S001/transcript.json --format eaf  --out out.eaf
```

Un-endorsed AI content is marked `[draft]` in reports (decision #76).
