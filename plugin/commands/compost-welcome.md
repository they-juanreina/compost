---
description: First-run orientation for compost — what it is and the three things to try next
allowed-tools: Bash(compost status:*), Bash(compost setup:*)
---

Welcome the user to compost and orient them. Keep it short.

First, get the lay of the land:
- Run `compost setup --json` to see if prerequisites are ready.
- Run `compost status --json` to see whether any seeds exist yet.

Then tailor the welcome:

**If no seeds exist:** explain that a "seed" is a research project (a question +
its sessions + the codes/themes that grow from them). Offer the two starting moves:
1. `compost init <name>` then drop recordings or documents
   (PDF/DOCX/PPTX/CSV/XLSX/TXT) into `Seeds/<name>/sessions/_inbox/`, then
   `compost watch --once`.
2. `compost init sample --from-sample` to explore a bundled example corpus first.

**If seeds exist:** summarize them (from `compost status`) and suggest the next
useful action — search the corpus (`/compost-status` then ask a question),
ingest more material, or review AI `[draft]` artifacts to endorse.

**If `compost setup` shows ❌ fails:** lead with those — nothing works until the
core prerequisites (Ollama + the bge-m3 model) are in place. Point at
`/compost-setup` to walk through fixes.

Close with the one-line mental model: *compost retrieves, stores, and tracks
provenance; you and Claude Code do the reasoning. Every AI suggestion is a
`[draft]` until you endorse it.*

Arguments: $ARGUMENTS
