---
description: Create, list, or migrate codebooks (interpretive lenses) in a compost seed
allowed-tools: Bash(compost codebook:*)
---

Manage codebooks — the interpretive lenses codes belong to (ADR 0001). A seed can hold several coexisting lenses over one corpus, each declaring a stance (`inductive | deductive | in_vivo | framework`); every code is scoped to one.

Dispatch on the user's argument:
- `list` → `compost codebook list` — show the lenses (the implicit `primary` plus any created), with stance.
- `new <name> --stance <stance> [--description ...]` → `compost codebook new ...` — create a lens. The stance is required; if the user didn't give one, ask which of the four fits before creating.
- `migrate [--apply]` → `compost codebook migrate` — assign pre-codebook codes to `primary`. Default is a dry-run preview; only pass `--apply` once the user confirms the previewed code list.

Pass `--seed` through when given. Report results from the `--json` output plainly. Creating or migrating is the researcher's act (not an AI draft) — don't invent a stance or apply a migration without the user's intent.

Arguments: $ARGUMENTS
