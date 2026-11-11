# plugin

Claude Code / Cowork plugin for compost. Three parts, all thin adapters over the
same domain core in `cli/src/lib` (see the repo-root `CLAUDE.md`):

- **Slash commands** (`commands/`, 8): `/compost-welcome`, `/compost-setup`,
  `/compost-ingest`, `/compost-status`, `/compost-tag`, `/compost-codebook`,
  `/compost-chat`, `/compost-blame`.
- **Skills** (`skills/`, 9): `compost-setup`, `thematic-coding`,
  `pattern-coding`, `analytic-memos`, `codebook-lenses`, `intercoder-agreement`,
  `saturation-analysis`, `journey-mapping`, `querying-research-knowledge`. The
  skills do the interpreting; compost stores, computes, and records provenance.
- **MCP server** (`mcp/`, 24 `compost_*` tools): status, blame, agreement,
  ingest, transcribe, export, models_doctor, search, get_session,
  create_highlight, create_code, create_theme, create_memo, list_memos, endorse,
  reject, rerun, code_suggest, code_apply, codebook_new, codebook_list,
  codebook_migrate, codebook_duplicate, codebook_merge.

AI-authored artifacts created through these tools are born `[draft]` and stay
untrusted until a researcher runs `compost endorse` (or archives them with
`compost reject`).

The manifest is `.claude-plugin/plugin.json`. Marketplace distribution is not set
up yet: the committed `dist/` still needs this workspace's `node_modules` and a
built `compost` CLI, so install from a local clone (see
[docs/install.md](../docs/install.md)).

See [ROADMAP.md § Agent integration](../ROADMAP.md#agent-integration).
