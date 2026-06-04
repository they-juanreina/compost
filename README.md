# compost

**Local-first, AI-first research analysis harness for coding agents and humans.**

Drop interview recordings and legacy research files (PDF, DOCX, PPTX, CSV, XLSX, TXT) into a seed. Compost transcribes audio with descriptive cues — typed silences, laughter, sighs, prosody — diarized by speaker, and normalizes legacy documents into the same shape. Everything is embedded locally and made searchable. A coding agent (Claude Code) reasons over the corpus through typed tools; every highlight, code, and theme it suggests carries three-actor provenance and stays a `[draft]` until a researcher endorses it.

Runs on your machine. **No API key required** — the filesystem is canonical, embeddings run on local Ollama, and the reasoning is done by whatever agent drives the tools (Claude Code, or any agent that can call a CLI).

## Quick start

Prerequisites (one-time — `compost setup` checks all of them): [Node 22+](https://nodejs.org), [Ollama](https://ollama.com) with the `bge-m3` embedding model, and — only if you want to transcribe audio — [OrbStack](https://orbstack.dev) or Docker plus a HuggingFace token. See [docs/install.md](docs/install.md).

```sh
# 1. Build the CLI (from a clone of this repo)
pnpm install && pnpm build

# 2. Verify prerequisites
compost setup            # prints a checklist; fix anything marked ❌

# 3. Make a seed and drop research material in its inbox
compost init my-study
cp ~/interviews/*.docx Seeds/my-study/sessions/_inbox/

# 4. Process the inbox (ingest → transcribe/normalize → embed)
compost watch --once

# 5. Search the corpus (grounded passages, no LLM)
compost search "what makes people distrust an alert" --seed my-study
```

Or try the bundled sample corpus without recording anything: `compost init sample --from-sample` then `compost search "confiar" --seed sample`.

## How it's used

Three surfaces over one engine:

- **CLI** — `compost <verb>`. JSON out by default (agents parse it), `--human` for pretty output. The full contract: `init`, `migrate`, `ingest`, `transcribe`, `watch`, `snap`, `status`, `blame`, `export`, `validate`, `reindex`, `config`, `search`, `session`, `create`, `endorse`, `setup`, `tag`, `code`, `rescan`, `saturate`.
- **Claude Code / Cowork plugin** — slash commands (`/compost-setup`, `/compost-ingest`, `/compost-status`, …) and 14 MCP tools. The agent searches, reads sessions, and authors highlights/codes/themes; you endorse. See [docs/host-llm-routing.md](docs/host-llm-routing.md) for why the agent does the reasoning and compost does the retrieval + storage + provenance.
- **Web UI** — coming in v0.2 (transcript player, drag-to-highlight, theme board). Today the surfaces are the CLI and the plugin.

## Provenance

Every change to every artifact is an append-only event in `.compost/events.sqlite` with a three-actor model — **researcher** (human, accountable), **agent** (deterministic software), **AI-suggestion** (raw model output, untrusted until endorsed). `compost blame <id>` prints the lineage chain. AI-authored artifacts surface as `[draft]` until `compost endorse` promotes them.

## Status

**v0.1 (shareable harness)** is feature-complete: ingest, transcription (WhisperX + pyannote + Silero), legacy document ingest, local embeddings (Ollama + LanceDB), BM25 retrieval, three-actor provenance, the Claude Code plugin, and the `compost setup` doctor.

Known limitations, tracked as issues:
- Retrieval is BM25 today; the embeddings index is built but dense ranking isn't wired into the query path yet ([#151](https://github.com/they-juanreina/compost/issues/151)).
- The web UI is the [v0.2 milestone](https://github.com/they-juanreina/compost/milestone/4).
- `compost serve`, `query`, and `synthesize` are stubs.

See [ROADMAP.md](ROADMAP.md) for the full design + milestone breakdown.

## License

MIT — see [LICENSE](LICENSE).
