---
description: Health-check compost's prerequisites and walk through any fixes
allowed-tools: Bash(compost setup:*), Bash(compost setup item:*), Bash(ollama:*), Bash(docker compose:*)
---

Run `compost setup --json` and read the `checks[]` array.

Summarize the checklist for the user grouped by status:
- ✅ `ok` — one line each, terse.
- ⚠️ `warn` — needed only for specific features (transcribe, diarization). Name the feature each blocks.
- ❌ `fail` — blocks the core loop (ingest → embed → search). Lead with these.

For every non-`ok` check, show its `fix` command verbatim. Then offer to run the safe ones **with the user's explicit confirmation**, one at a time:
- `ollama pull <model>` — safe to offer.
- `docker compose -f transcriber/compose.yaml up --build -d` — offer, but note it's a multi-GB first build.
- Anything involving installing software (Ollama, OrbStack), setting env vars (HUGGINGFACE_TOKEN), or accepting a HuggingFace license in the browser — DO NOT run. Print the step and ask the user to do it themselves; these are the prohibited/manual actions.

If `ready` is true, say so plainly: "compost is ready — try `/compost-ingest <path>`." If false, end with the single most important next action.

## Maintaining a set-up install

`compost setup` only surfaces an item when it's broken — it can't change one that's already set. To act on a single item, use `compost setup item`:
- `compost setup item list --json` — every check + the `actions[]` it supports.
- `compost setup item show <id> --validate --json` — re-probe one item; `--validate` adds a live credential check in a `live` field.
- `compost setup item run <id> <action> --yes` — run one action.

Two rules:
- **Misattribution:** if the report shows `hf-token` ok but a `pyannote:*` row is a 403, the token is likely dead, not the license — run `compost setup item show hf-token --validate` before reporting a license issue.
- **Credentials stay a hand-off:** never set, renew, or revoke a token for the user. Hand off `printf %s "$NEW" | compost setup item run hf-token renew` (change/renew) or `compost setup item run hf-token forget` (local only) — and always say that truly revoking means deleting the token at https://hf.co/settings/tokens. `model:* pull` and `secret-perms:* fix` are safe to run with confirmation.

Arguments: $ARGUMENTS
