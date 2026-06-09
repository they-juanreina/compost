# Installing compost

Compost runs entirely on your machine. The core loop (ingest documents → embed →
search, plus highlight/code/theme + provenance) needs only Node and Ollama.
Audio transcription additionally needs a HuggingFace token (for pyannote); on
Apple Silicon it runs **natively** (Metal), with Docker as a cross-platform
fallback — see [transcription.md](transcription.md).

Run `compost setup` at any point — it checks every item below and tells you
exactly what's missing and how to fix it.

## 1. Prerequisites

### Always required

- **Node 22+** and **pnpm 10+** — `node --version`, `pnpm --version`.
- **[Ollama](https://ollama.com)** for local embeddings (no API key, no cloud):
  ```sh
  ollama serve          # or just open the Ollama app
  ollama pull bge-m3    # the embedding model compost uses
  ```

### Required only for audio transcription

- **Apple Silicon (default):** a Python 3.11+ venv with the native ASR deps —
  the fastest path, no container. **Other platforms:** **[OrbStack](https://orbstack.dev)** or Docker Desktop
  (cross-platform fallback). Either way, see [transcription.md](transcription.md) for setup.
- **A HuggingFace token** for pyannote speaker diarization (a gated model):
  1. Create a token at <https://huggingface.co/settings/tokens>.
  2. Accept the license on **both** gated repos, logged in as the token's account:
     - <https://huggingface.co/pyannote/speaker-diarization-3.1>
     - <https://huggingface.co/pyannote/segmentation-3.0>
  3. Store the token where compost can read it. The most secure option is the
     OS keychain:
     ```sh
     compost secrets set HUGGINGFACE_TOKEN     # reads the value from stdin
     ```
     Or export it / drop it in `.env.local` at the repo root (gitignored):
     ```
     HUGGINGFACE_TOKEN=hf_xxxxxxxxxxxxxxxxxxxx
     ```
     Compost resolves the token by precedence — env var > OS keychain >
     `~/.compost/secrets.env` (0600). See
     [SECURITY.md → Storing your tokens](../SECURITY.md#storing-your-tokens) for
     the full hierarchy and multi-user guidance.

> The license check in `compost setup` fetches the gated model *file*, not the
> repo metadata — the metadata endpoint returns 200 even when you haven't
> accepted the license, so "the model page loads" is not proof. If `setup`
> reports a 403, you haven't accepted (or you're logged into a different HF
> account than the token belongs to).

## 2. Build the CLI

```sh
git clone https://github.com/they-juanreina/compost.git
cd compost
pnpm install
pnpm build
```

This produces `cli/bin/compost.js`. Make it callable as `compost` either by
linking it (`pnpm --filter compost-cli link --global`) or by adding `cli/bin`
to your `PATH`. The plugin's MCP server finds the CLI via `compost` on PATH, or
via a `COMPOST_CLI` env var pointing at `cli/dist/index.js` — see
[host-llm-routing.md](host-llm-routing.md).

## 3. Verify

```sh
compost setup
```

A checklist prints. `❌ fail` blocks the core loop (fix those first); `⚠️ warn`
blocks only a specific feature (transcription, diarization) and can wait until
you need it. When `ready` is true you're done.

## 4. Install the plugin (optional, for Claude Code / Cowork)

The plugin gives you slash commands and MCP tools so an agent can drive compost.
It does **not** bundle the CLI (the CLI's native deps — better-sqlite3, lancedb
— must build per-platform on your machine), so step 2 is a prerequisite.

- **Claude Code:** `/plugin install they-juanreina/compost`
- **Cowork:** install from the Cowork registry.

Then run `/compost-setup` inside Claude Code to confirm everything's wired.

## 5. First seed

```sh
compost init my-study
# drop recordings and/or PDFs/DOCX/CSV/XLSX into the inbox:
cp ~/material/* Seeds/my-study/sessions/_inbox/
compost watch --once         # process the inbox
compost status --seed my-study
```

Or unpack the bundled sample to explore the shape first:

```sh
compost init sample --from-sample
compost search "confiar" --seed sample
```

## Offline note

After the first `ollama pull` and (if transcribing) the first container build,
compost runs fully offline — embeddings, retrieval, transcription, and
provenance are all local. Only the one-time model downloads need the network.
