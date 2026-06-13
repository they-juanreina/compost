---
name: codebook-lenses
description: Manage the interpretive lenses (codebooks) a compost seed's codes belong to — create a new lens, duplicate one as an independent frame (same-seed or reused from another study), or merge one lens into another. Use whenever the user wants a second coding frame over the same corpus, to apply a validated codebook from a prior study as a deductive frame, to consolidate two lenses, to branch a lens to evolve separately, or to qualify legacy code ids. Compost holds several stance-declared lenses over one corpus at once (ADR 0001) rather than one master codebook — this skill is how you create and reshape them.
---

# codebook-lenses

A codebook is an **interpretive lens** codes belong to — each declaring a stance
(`inductive | deductive | in_vivo | framework`). A seed can hold several over one
corpus at once (ADR 0001: Haraway's situated knowledges, Escobar's pluriverse —
*partial standpoints held together*, not one master codebook). The verbs live in
`compost codebook`; this skill frames the multi-lens workflow and the
consequential `merge`.

## Verbs (dispatch on the user's intent)

- `compost codebook list` — show the lenses (the implicit `primary` plus any
  created), with stance.
- `compost codebook new <name> --stance <stance> [--description ...]` — create a
  lens. The stance is required; if the user didn't give one, ask which of the
  four fits before creating.
- `compost codebook migrate [--apply]` — stamp pre-codebook codes onto `primary`.
- `compost codebook migrate-ids [--apply]` — qualify legacy `C-<slug>` ids to
  `C-<codebook>/<slug>` and namespace their files (dry-run first; refuses on a
  dirty git tree, `--force` to override).
- `compost codebook duplicate <source> <new-name> [--from <seed>]` — **copy a
  lens as a new, independent frame.** See below.
- `compost codebook merge <from> <into> [--apply]` — **fold one lens into
  another.** See below. The risky one.

All of these are the **researcher's act** (structural setup), not an AI
`[draft]` — never invent a stance, apply a migration, or duplicate/merge without
the user's intent.

## `duplicate` — a fresh, un-grounded copy

`duplicate` copies a codebook's **definitions + a `derived_from` lineage link**
into a new frame. **Coded instances (evidence) do NOT travel** — the copy enters
*un-grounded* and earns its grounding by being coded against the local data
(framework / deductive coding, Ritchie & Spencer). Category links aren't copied.

- **Same-seed** (`duplicate epistemology epistemology-v2`): a parallel lens over
  the same corpus, to evolve independently. (If you instead want to *keep* the
  coding, edit the codebook in place — history is preserved by events; you don't
  need duplicate.)
- **Cross-seed** (`duplicate epistemology borrowed --from prior-study`): reuse a
  validated frame from another study as a hypothesis here. It correctly shows
  **zero local saturation** until re-coded — a borrowed code is a hypothesis in
  *your* corpus, not inherited evidence.
- **Refuses an in_vivo source** — in_vivo names are participant-verbatim and only
  hold against their own evidence; code a fresh in_vivo lens instead.
- Additive: it rejects (never overwrites) when the target name already exists.

## `merge` — fold a lens in, keep-distinct (consequential)

`merge <from> <into>` re-homes `<from>`'s codes into `<into>` (an `update`, not a
copy — **identity, evidence, and history preserved**), then **reject-archives**
`<from>` (never deletes). Colliding names are **kept distinct**, never silently
fused: an incoming `distrust` that clashes with the target's becomes
`distrust-from-<fromframe>`, logged via an `update(name)` event. Coverage math
(`saturate` / `agreement`) then sees the two as distinct until the researcher
explicitly de-dups.

It moves files and archives a frame, so it is **dry-run-first**:

1. Run `compost codebook merge <from> <into> --json` (no `--apply`) and show the
   preview: which codes re-home (and which get renamed), plus `blocking` — any
   theme or category link that cites a re-homing code.
2. **If `blocking` is non-empty, stop.** Merge refuses to write because re-homing
   a code woven into a theme would silently change that theme's lens membership,
   and a category link would dangle. Have the researcher re-cite or drop those
   first.
3. Only with the user's confirmation, run `compost codebook merge <from> <into>
   --apply` (it also refuses on a dirty git tree unless `--force`).
4. Afterward, suggest `compost reindex --vectors` to refresh chunk code_ids.

## Why this shape

Two lenses over one corpus is the point, not a problem to resolve — so the
default is *coexistence*, and `merge` is the deliberate, reversible-by-archive
exception. `duplicate`'s asymmetry (definitions travel, evidence doesn't) is what
keeps a borrowed frame honest: it can't inherit another study's grounding. Both
verbs preserve provenance — `duplicate` via `derived_from`, `merge` via
identity-preserving updates — so `compost blame` always shows where a code came
from.

## Verifying

Preview before you write: `merge` without `--apply` and `duplicate` into a
throwaway name are both safe to run and inspect. The lib behavior is covered by
`cli/src/lib/codebookDuplicate.test.ts` and `codebookMerge.test.ts`; after the
verbs run, `compost codebook list` confirms the resulting frames and
`compost blame <new-code-id>` shows the lineage / re-home chain.
