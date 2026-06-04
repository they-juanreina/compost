# Host-LLM routing: who does the reasoning

Compost is deliberately **not** an LLM application. It does not ship a built-in
model or require an API key for its core loop. Understanding this split is the
key to the architecture — and the reason a contributor shouldn't reach for an
LLM adapter when adding a feature.

## The split

| Layer | Owns | Examples |
|---|---|---|
| **compost** (CLI + storage) | Retrieval, storage, schemas, provenance, deterministic transforms | chunking, BM25 ranking, the event log, transcript normalization, citation validation |
| **The host agent** (Claude Code, Cowork, any tool-calling agent) | Reasoning, summarization, judgment | "which of these passages answers the question", "draft a theme from these codes" |
| **Local Ollama** | Embeddings only (and optional local chat models) | `bge-m3` vectors for the index |

The host agent reasons *over what compost retrieves*, then writes back through
compost's typed tools. Compost records every write with provenance. Nothing in
the core path calls a cloud LLM.

## Why

1. **No API key for the core loop.** A research team can run the whole
   ingest → embed → search → highlight → code → theme → endorse loop with only
   Ollama installed. The reasoning is done by the agent the researcher is
   already using (Claude Code).
2. **Provenance stays honest.** When the agent authors a highlight via
   `compost_create_highlight`, the event records `actor_type: ai` with an
   `actor_id` like `claude-code:0.1.0:<hash>`. It lands as a `[draft]`. A
   researcher's `compost endorse` is the only thing that promotes it. The CLI
   never auto-approves AI output.
3. **One contract, many callers.** Because the logic lives in `compost <verb>`,
   the same behavior is reachable from the CLI, the MCP tools, CI, and any other
   coding agent — not just Claude Code. (See the project memory note on building
   the CLI verb before wrapping it in a skill.)

## How the MCP server reaches the CLI

The plugin's MCP server shells out to the compost CLI as a subprocess — it does
**not** import it in-process (the CLI calls `process.exit` on some paths, which
would kill the MCP server). Resolution order:

1. `COMPOST_CLI` env var — an explicit path. If it ends in `.js`, it's run with
   `node`; otherwise it's treated as an executable.
2. `compost` on `PATH` — from a global link or `npm i -g`.

If neither resolves, tool calls return a `CLI_NOT_FOUND` error pointing back at
[install.md](install.md). The MCP server itself is pure JS (only the MCP SDK),
which is why its built `dist/` is committed — Claude Code's plugin install
copies files without running a build.

## What this means for contributors

When a skill or MCP tool needs a behavior, **build the `compost <verb>` first**,
then wrap it. Don't have the skill reconstruct logic inline, and don't add an
LLM call into the core path — reasoning belongs to the host agent, retrieval and
storage belong to compost.
