# compost

**Local-first, AI-first research analysis harness for coding agents and humans.**

Drop interview recordings and legacy research files (PDF, DOCX, PPTX, CSV, XLSX, TXT) into a seed. Compost transcribes audio with descriptive cues — typed silences, laughter, sighs, prosody — diarized by speaker, and normalizes legacy documents into the same shape. Everything is embedded locally and made searchable. A coding agent (Claude Code) reasons over the corpus through typed tools; every highlight, code, and theme it suggests carries three-actor provenance and stays a `[draft]` until a researcher endorses it.

Runs on your machine. **No API key required** — the filesystem is canonical, embeddings run on local Ollama, and the reasoning is done by whatever agent drives the tools (Claude Code, or any agent that can call a CLI).

## Quick start

Prerequisites (one-time — `compost setup` checks all of them): [Node 22+](https://nodejs.org), [Ollama](https://ollama.com) with the `bge-m3` embedding model, and — only if you want to transcribe audio — a HuggingFace token (for pyannote), stored securely with `compost secrets set HUGGINGFACE_TOKEN` (env var > OS keychain > `0600` dotenv; see [SECURITY.md](SECURITY.md#storing-your-tokens)). On Apple Silicon, transcription runs **natively** (Metal, ~16× realtime); Docker is the cross-platform fallback. See [docs/install.md](docs/install.md) and [docs/transcription.md](docs/transcription.md).

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

- **CLI** — `compost <verb>`. JSON out by default (agents parse it), `--human` for pretty output. The full contract: `init`, `migrate`, `ingest`, `transcribe`, `watch`, `snap`, `status`, `blame`, `export`, `backup`, `validate`, `reindex`, `config`, `search`, `session`, `create`, `endorse`, `setup`, `secrets`, `tag`, `code`, `rescan`, `saturate`, `codebook`, `category`, `recode`, `agreement`.
- **Claude Code / Cowork plugin** — slash commands (`/compost-setup`, `/compost-ingest`, `/compost-codebook`, …) and 19 MCP tools. The agent searches, reads sessions, and authors highlights/codes/themes; you endorse. See [docs/host-llm-routing.md](docs/host-llm-routing.md) for why the agent does the reasoning and compost does the retrieval + storage + provenance.
- **Web UI** — a later milestone (transcript player, drag-to-highlight, theme board). Today the surfaces are the CLI and the plugin.

## Provenance

Every change to every artifact is an append-only event in `.compost/events.sqlite` with a three-actor model — **researcher** (human, accountable), **agent** (deterministic software), **AI-suggestion** (raw model output, untrusted until endorsed). `compost blame <id>` prints the lineage chain. AI-authored artifacts surface as `[draft]` until `compost endorse` promotes them.

`.compost/events.sqlite` is **canonical and not rebuildable** — snapshots and the markdown artifacts derive from it, never the reverse. It lives inside the per-seed `.compost/` (gitignored by default), so it must travel with the seed on any move or backup: copy the whole seed folder (including `.compost/`), or run `compost backup` to export a portable copy of the ledger plus a W3C PROV-O bundle into `exports/`. Losing `.compost/` leaves the markdown but makes every claim unattributable.

## Status

**v0.2.0** adds the **codebook & category data model**: codes belong to declared interpretive lenses (codebooks), group into second-cycle categories, and ground themes through a heterogeneous `{code | category}` evidence set — with codebook-scoped agreement/saturation, codebook-filtered retrieval, and source/author attribution for sourced documents. The **v0.1 (shareable harness)** base is feature-complete: ingest, transcription (native Parakeet/Whisper + pyannote on Metal, Docker fallback), legacy document ingest, local embeddings (Ollama + LanceDB), hybrid retrieval (BM25 + dense vectors fused via Reciprocal Rank Fusion), grounded chat with enforced citations, three-actor provenance, the Claude Code plugin, and the `compost setup` doctor.

Retrieval is hybrid end to end: `compost watch` builds the LanceDB index by default, and both `compost search` and `compost chat` fuse BM25 with dense LanceDB results via RRF when the index and an embeddings provider are present — reporting `retrieval: "hybrid"` — and fall back cleanly to BM25 (`retrieval: "bm25"`) when they're not. `compost chat` answers only from retrieved passages and validates every citation (utterance must be in the retrieval set, quote must match verbatim) before returning.

Known limitations:
- The cross-encoder rerank stage (`retrieval/src/rerank.ts`) is implemented and unit-tested but has no CLI caller yet, so the final `hybrid → rerank → top-N` step is effectively off — `search` and `chat` return RRF-fused results directly.
- `compost codebook merge | fork | import` are stubs; the qualified-code-id foundation they build on shipped in v0.2.0 (tracked in [#269](https://github.com/they-juanreina/compost/issues/269)).
- The web UI is an upcoming milestone.
- `compost serve`, `query`, and `synthesize` are stubs.

See [ROADMAP.md](ROADMAP.md) for the full design + milestone breakdown.

## License

MIT — see [LICENSE](LICENSE).
