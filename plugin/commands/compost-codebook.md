---
description: Create, list, migrate, duplicate, or merge codebooks (interpretive lenses) in a compost seed
allowed-tools: Bash(compost codebook:*)
---

Manage codebooks — the interpretive lenses codes belong to (ADR 0001). A seed can hold several coexisting lenses over one corpus, each declaring a stance (`inductive | deductive | in_vivo | framework`); every code is scoped to one.

Dispatch on the user's argument:
- `list` → `compost codebook list` — show the lenses (the implicit `primary` plus any created), with stance.
- `new <name> --stance <stance> [--description ...]` → `compost codebook new ...` — create a lens. The stance is required; if the user didn't give one, ask which of the four fits before creating.
- `migrate [--apply]` → `compost codebook migrate` — assign pre-codebook codes to `primary`. Default is a dry-run preview; only pass `--apply` once the user confirms the previewed code list.
- `migrate-ids [--apply]` → `compost codebook migrate-ids` — qualify legacy `C-<slug>` ids to `C-<codebook>/<slug>` and namespace their files. Dry-run by default; `--apply` refuses on a dirty git tree (`--force` to override).
- `duplicate <source> <new-name> [--from <seed>]` → `compost codebook duplicate ...` — copy a lens as a new, independent frame. Definitions + a `derived_from` lineage link travel; **evidence does not** — the copy enters un-grounded and must be coded against the local data. `--from <seed>` reuses a validated frame from another study. Refuses an in_vivo source.
- `merge <from> <into> [--apply]` → `compost codebook merge ...` — fold one lens into another: re-home `<from>`'s codes (identity + evidence preserved), keep colliding names distinct, then reject-archive `<from>`. Dry-run by default; `--apply` writes (refuses on a dirty tree, and refuses when a re-homing code is cited by a theme or category link — resolve those first). Preview before applying.

Pass `--seed` through when given. Report results from the `--json` output plainly. Every verb here is the researcher's act (not an AI draft) — don't invent a stance, apply a migration, or merge/duplicate without the user's intent; for `merge` especially, show the dry-run preview and get confirmation before `--apply`.

Arguments: $ARGUMENTS
