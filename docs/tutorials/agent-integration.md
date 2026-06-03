# Tutorial: agent integration (Bash · Claude Code · MCP)

compost is agent-callable three ways. All three drive the same Node core —
there is exactly one mutation path.

## 1. Bash (any coding agent)

Every operation is a `compost` subcommand emitting JSON by default:

```sh
compost status --seed my-study          # {"schema_version":"1.0", "seeds":[...]}
compost ingest ./drop --seed my-study   # {"queued": 3, "skipped": 0, ...}
compost chat "what do users distrust?" --seed my-study
compost blame <artifact-sha> --seed my-study
```

Exit codes are meaningful: `0` ok, `1` error, `2` transcriber down/model
missing (`compost transcribe`), `3` insufficient evidence (`compost chat`).
Parse stdout as JSON; pass `--human` only for terminals.

## 2. Claude Code plugin

```sh
claude plugins add ./plugin
```

Adds slash commands (`/compost-status`, `/compost-ingest`, `/compost-blame`,
`/compost-chat`, `/compost-tag`), the three refactored skills
(querying-research-knowledge, thematic-coding, saturation-analysis), and the
MCP server — all declared in `plugin/.claude-plugin/plugin.json`.

## 3. MCP server (typed tools)

The bundled MCP server exposes typed tools that wrap the CLI:
`compost_status`, `compost_blame`, `compost_export` (read-only) and
`compost_ingest`, `compost_transcribe` (mutations, surfaced separately). Point
any MCP client at `node plugin/dist/mcp/server.js`.

## Provenance contract

Every artifact an agent creates is an event with `actor_type=agent` (or `ai`
for raw model output), carrying `agent_name@version` and, for LLM output,
`model` + `prompt_hash`. Nothing AI-authored is promoted into exports until a
researcher endorses it or its eval verdict clears the floor.
