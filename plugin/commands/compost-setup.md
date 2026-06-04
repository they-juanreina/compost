---
description: Health-check compost's prerequisites and walk through any fixes
allowed-tools: Bash(compost setup:*), Bash(ollama:*), Bash(docker compose:*)
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

Arguments: $ARGUMENTS
