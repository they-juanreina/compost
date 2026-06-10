---
name: compost-setup
description: Verify a compost install is ready and walk the researcher through any missing prerequisites — Ollama and the bge-m3 embedding model, Docker/OrbStack, the transcriber container, the HuggingFace token and pyannote license, and a Seeds/ workspace. Also maintain ONE already-set item — change, renew, or forget the HuggingFace token, re-validate a live credential, re-pull a model, or fix file permissions. Use when setting up compost for the first time, when ingest/search/transcribe fails with a connection or model error, when onboarding a new teammate, when the user asks why compost isn't working or what's missing, or when a set-up user needs to rotate/renew/revoke a token or repair a single prerequisite. Wraps the read-only `compost setup` health-check and the `compost setup item` maintenance verbs.
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
- A set-up user needs to **maintain one item**: change / renew / revoke (forget)
  the HuggingFace token, re-check whether a stored token is still live, re-pull a
  model, or tighten a loose secret file. See "Maintain one item" below.

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

## Maintain one item (a set-up install)

`compost setup` is gap-driven: it only surfaces an item when it's broken, so it
is *not* the tool for changing an item that's already set. For that, address one
item by its stable check id with the `compost setup item` verbs:

- `compost setup item list --json` — every check, its status, and the lifecycle
  `actions[]` available on it (each action carries a `side`: `local`, `remote`,
  or `both`). Read this to discover what's addressable; don't hard-code it.
- `compost setup item show <id> [--validate] --json` — re-probe ONE item.
  `--validate` adds a live credential probe in a separate `live` field.
- `compost setup item run <id> <action> --yes --json` — run one action.

**The misattribution rule (important).** The HuggingFace `hf-token` check is
presence-only: a *revoked or expired* token still reports `ok: set`, and its 403
surfaces on the `pyannote:*` rows as a phantom "license not accepted". So when
the canonical report shows `hf-token` ok **but a `pyannote:*` row is a 403**, do
NOT report a license problem — run `compost setup item show hf-token --validate`
to get the live verdict. If `live` is `fail`, the token is dead: hand off renew.

**Credential lifecycle stays a hand-off.** Extend the "never set a secret for
the user" rule:

- To **change / renew** the token: hand the user
  `printf %s "$NEW_TOKEN" | compost setup item run hf-token renew` (reads the
  value from stdin so it stays out of shell history; stores it, then live-checks
  it). Never run it for them, and never paste a token value into a command.
- To **revoke**: the action is named `forget` because compost can only remove
  its *local* copy — it **cannot and must never** delete the token server-side
  for the user. Hand off `compost setup item run hf-token forget` and ALWAYS
  relay the two sides: compost forgot the local copy; the user must delete the
  token at https://hf.co/settings/tokens to truly revoke it. If the token is a
  shell export, compost refuses to imply success — relay the `unset` line.

**Safe, non-secret fixes** the agent MAY run with confirmation (these have no
remote half): `compost setup item run model:<name> pull --yes` and
`compost setup item run secret-perms:<path> fix --yes`.

## Why read-only

`compost setup` (the report) only probes; it never installs or mutates — that
keeps it safe for CI and other agents, and keeps the human in the loop for the
irreversible or secret-touching steps. The mutating `compost setup item run`
verbs are explicitly opt-in (a TTY prompt, or `--yes` when piped). The skill is
the cover letter; the `compost setup` verbs are the contract.
