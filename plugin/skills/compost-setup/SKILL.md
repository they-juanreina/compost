---
name: compost-setup
description: Verify a compost install is ready and walk the researcher through any missing prerequisites — Ollama and the bge-m3 embedding model, Docker/OrbStack, the transcriber container, the HuggingFace token and pyannote license, and a Seeds/ workspace. Use when setting up compost for the first time, when ingest/search/transcribe fails with a connection or model error, when onboarding a new teammate, or when the user asks why compost isn't working, what's missing, or how to finish setup. Wraps the read-only `compost setup` health-check.
---

# compost-setup

Get a compost workspace from "just installed" to "ready to ingest" by probing
every prerequisite and walking the researcher through what's missing — without
running anything destructive or installing software on their behalf.

## When to use

- First-time setup, or onboarding a teammate.
- `compost ingest` / `search` / `transcribe` errors with "Ollama unreachable",
  "model not installed", "transcriber not reachable", or a pyannote 403.
- The user asks "is compost ready?", "what's missing?", "why won't this work?".

## How it works

`compost setup --json` runs read-only probes and returns a checklist:

```json
{
  "ready": false,
  "checks": [
    { "id": "ollama", "label": "Ollama running", "status": "ok", "detail": "3 models installed", "fix": null },
    { "id": "model:bge-m3", "label": "Model bge-m3", "status": "fail", "detail": "not installed (embeddings will fail)", "fix": "ollama pull bge-m3" },
    { "id": "pyannote:pyannote/segmentation-3.0", "label": "pyannote license: pyannote/segmentation-3.0", "status": "warn", "detail": "license not accepted (403 on the gated model file)", "fix": "Accept at https://huggingface.co/pyannote/segmentation-3.0 …" }
  ]
}
```

Status meanings:
- `ok` — satisfied.
- `fail` — blocks the **core loop** (ingest → embed → search). Must fix.
- `warn` — blocks a **specific feature** only (transcribe needs Docker +
  container + HF; diarization needs the pyannote licenses). Fine to defer if
  the researcher isn't transcribing audio yet.

`ready` is true when there are no `fail` checks.

## Procedure

1. Run `compost setup --json`. Parse `checks[]`.
2. Report grouped by status. Lead with `fail`, then `warn` (naming the feature
   each blocks), then a terse `ok` summary.
3. For each non-`ok` check, show its `fix` verbatim.
4. Offer to run the **safe, reversible** fixes with explicit confirmation, one
   at a time:
   - `ollama pull <model>` ✅
   - `docker compose -f transcriber/compose.yaml up --build -d` ✅ (warn: multi-GB first build)
5. **Never** do these for the user — print the step and hand it off:
   - Installing Ollama / OrbStack / Docker.
   - Setting `HUGGINGFACE_TOKEN` (a secret). Hand off the secure command for the
     user to run themselves: `compost secrets set HUGGINGFACE_TOKEN` (stores it
     in the OS keychain; reads the value from stdin).
   - Accepting a HuggingFace license in the browser (note: **both**
     `pyannote/speaker-diarization-3.1` and `pyannote/segmentation-3.0` need
     accepting, on the account that owns the token).
6. Re-run `compost setup --json` after fixes to confirm.
7. When `ready` is true: "compost is ready — try `/compost-ingest <path>`."

## Why read-only

`compost setup` only probes; it never installs or mutates. That keeps it safe
for CI and other agents, and keeps the human in the loop for the irreversible
or secret-touching steps. The skill is the cover letter; `compost setup` is the
contract.
