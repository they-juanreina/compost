# Cowork + Claude Code packaging

compost ships one plugin source, two distribution channels. Both are built
from `plugin/` on tag by `.github/workflows/release.yml`.

## Claude Code

```sh
claude plugins add ./plugin
```

Reads `plugin/.claude-plugin/plugin.json` — slash commands (`/compost-status`,
`/compost-ingest`, `/compost-blame`, `/compost-chat`, `/compost-tag`), the
three refactored skills, and the MCP server.

## Cowork registry

```sh
cowork plugins add compost
```

Reads `plugin/.cowork/manifest.json`, derived from the Claude Code manifest
(`derived_from` points back at it) — same commands, skills, and MCP server,
declared in the Cowork registry's shape. Keeping it derived means the two
manifests can't drift: the release workflow regenerates `.cowork/manifest.json`
from `plugin.json` and fails the build if they're out of sync.
