# Design: un-stub `codebook merge | fork | import` + the compound code ref

Status: **design note (decision needed)** · Date: 2026-06-12 · Issue: [#269](https://github.com/they-juanreina/compost/issues/269) · Depends on: [ADR 0001 — Codebook multiplicity](./adr/0001-codebook-multiplicity.md)

`compost codebook merge | fork | import` ship as honest stubs (`cli/src/commands/codebook.ts`). Un-stubbing them forces a data-model decision the slice-1 work deferred: **today a code's identity is its name, globally unique per seed**, but merge/fork/import all create situations where two codes named the same thing must coexist in one seed under different frames. This note specifies each verb, surfaces the collision, lays out the ref options with their blast radius, and recommends one — leaving the decision to the maintainer because it ripples through every consumer that references a code by `C-<slug>`.

## The collision (why this isn't additive)

A code lives at `codebook/<slug>.md`, addressed by its slug; its human id is `C-<slug>` (`createCode`, `cli/src/lib/artifacts.ts`). The path and the id both assume **one `distrust` per seed**. Every cross-frame operation breaks that:

- **fork** — branch an existing codebook's codes into a new lens *over the same seed*. If the fork copies codes, `codebook/distrust.md` already exists → collision on the very first code.
- **merge** — fold codebook A into codebook B. If both coded `distrust` under their own lens, the two are *distinct codes with the same name* — merging must keep both addressable, not silently overwrite.
- **import** — bring a codebook (and its codes) from another seed in as a shareable frame. The imported `distrust` collides with a local `distrust`.

ADR 0001 already anticipated this: **events carry `codebook_id` from day one**, so the provenance log can always tell two same-named codes apart. What's missing is a *reference* form — how a highlight, theme, category link, or CLI argument names "the `distrust` in `CB-epistemology`" vs "the `distrust` in `CB-pluriversal-justice`." That is the compound `(codebook_id, code_id)` ref #269 calls for.

## What references a code today (the blast radius)

Any ref scheme change has to be honored by every reader that resolves `C-<slug>`:

| Consumer | How it refs a code | File |
|---|---|---|
| code file on disk | `codebook/<slug>.md` | `artifacts.ts` |
| theme evidence | `evidence: [code:C-x:CB-…]` (post-#266) / legacy `codes[]` | `themes.ts`, `saturate.ts` |
| category links | `link(code → category)` payload `{code: C-x}` | `categories.ts` |
| recode / agreement | `C-x` in link events, κ/α by code | `recode.ts`, `agreement.ts` |
| blame / endorse | resolves `C-x` create event | `artifacts.ts` |
| retrieval metadata | `code_ids: [C-x]` on chunks | `retrieval`, #275 |

The compound ref must round-trip through all of these, or merge/fork/import silently mis-attribute coverage and provenance.

## Ref options

### Option A — namespace the code by codebook on disk + in the id

Code files move to `codebook/<CB-slug>/<code-slug>.md`; the human id becomes `C-<cb-slug>/<code-slug>` (or `CB-epistemology:C-distrust`). The frame is *in* the id, so collisions are impossible by construction.

- **Pro:** the id is self-describing; `blame C-epistemology/distrust` is unambiguous; the filesystem mirrors the frame structure.
- **Con:** every existing `C-<slug>` ref (themes, links, chunk `code_ids`, test fixtures) must migrate to the qualified form, *or* the resolver must accept a bare `C-<slug>` and qualify it against the default frame (a back-compat shim, like the `codebook_id` lazy default). Largest churn; cleanest end state.

### Option B — compound ref only on collision (qualify lazily)

Codes keep `C-<slug>` and `codebook/<slug>.md` while the slug is unique in the seed. A merge/fork/import that *would* collide qualifies **only the incoming code**: `C-distrust__epistemology` (slug-suffixed) at `codebook/distrust__epistemology.md`. Non-colliding refs never change.

- **Pro:** minimal churn — existing seeds and refs are untouched; only collisions pay the qualification cost. Matches #269's literal wording ("the compound ref becomes necessary … when code names collide").
- **Con:** two id forms coexist (`C-distrust` and `C-distrust__epistemology`), so resolvers and humans must understand both; the suffix is a second naming convention; "which frame owns the bare `C-distrust`?" needs a tie-break rule.

### Option C — always-compound logical ref, flat storage

Storage stays flat (`codebook/<slug>.md` keyed by a content hash or a per-frame counter), and every code ref is *always* the pair `(codebook_id, code_id)` — surfaced as `CB-epistemology:C-distrust`. The bare `C-distrust` is only ever shorthand resolved against a default/only frame.

- **Pro:** one uniform ref everywhere; no "sometimes qualified" ambiguity.
- **Con:** touches every ref site at once (like A) without A's self-describing filesystem; the most invasive for the least visible payoff during single-frame use.

## Verb semantics (proposed, pending the ref decision)

- **fork `<source>` `<new-name>`** — create codebook `CB-<new-name>` (copy stance/description), then for each non-archived code in `<source>` emit `create(code, …, codebook_id=CB-<new-name>)` with a fresh artifact id (the SHA changes with the frame) and an `inputs`/note linking the origin code for `blame` lineage. Category links within the source are **not** copied (a fork is a fresh second-cycle pass). Open: does fork copy codes at all, or create an empty sibling lens? (ADR 0001 says "new lens over the same seed" — ambiguous between "branch" and "blank".)
- **merge `<from>` `<into>`** — re-emit each of `<from>`'s codes as belonging to `<into>` (an `update(codebook_id)` event, preserving artifact identity + history), then **reject-archive** `<from>` (never delete — `reject` archives, ADR 0001). Colliding names resolve via the chosen compound ref; coverage math (saturate, agreement) must treat the two as distinct until/unless the researcher explicitly de-dupes.
- **import `<seed>` `<codebook>`** — copy the codebook artifact + its codes' create events into this seed as a new frame, preserving their original `codebook_id` lineage in `inputs` for citation. Cross-seed highlight evidence does **not** travel (the highlights live in the other seed) — an imported code arrives as a *definition-bearing frame*, evidence re-attached locally. Open: is an evidence-less imported code valid, or must import also bring (read-only) highlights?

## Recommendation

**Option B (qualify-on-collision) for the ref, with the resolver accepting both forms.** It matches #269's intent, keeps every existing seed and ref untouched (no migration of the whole corpus mid-milestone, consistent with ADR 0003's "don't churn during schema change"), and confines the new naming convention to the codes that actually collide. The cost — two id forms — is bounded and local, where Options A/C impose a seed-wide ref migration for a feature most single-lens studies never hit.

Concretely, if the maintainer agrees, the build order is: (1) a `resolveCodeRef(seed, ref)` helper that accepts `C-<slug>`, `C-<slug>__<cb>`, and `CB-<cb>:C-<slug>`, returning `{id, codebook_id}` — the single choke point every consumer routes through; (2) `import` (lowest risk — cross-seed, no same-seed collision unless names clash, errors clearly until the resolver lands); (3) `fork`; (4) `merge` (highest risk — touches coverage math). Each verb gets the same adversarial review + regression tests as the rest of the milestone.

## Open questions for the maintainer

1. **Ref scheme: A, B, or C?** (Recommend **B**.) This gates all three verbs.
2. **Does `fork` copy codes, or create an empty sibling lens?** (ADR 0001 wording is ambiguous.)
3. **Does `import` bring evidence/highlights, or only the definition-bearing frame?** (Recommend: frame only; re-attach evidence locally.)
4. **After `merge`, are two same-named codes auto-deduped or kept distinct?** (Recommend: kept distinct; de-dup is a separate, explicit researcher action with its own provenance.)
5. **Bare-`C-slug` tie-break:** when a bare ref is ambiguous across frames, error-and-list, or resolve against the primary/only frame? (Recommend: error-and-list, mirroring `resolveCategory`.)

## Why a design note, not code

Un-stubbing these verbs without settling the ref scheme would bake a guess into every code-referencing consumer (themes, categories, recode, agreement, blame, retrieval) — the exact "genuinely ambiguous data-model decision" that warrants the maintainer's call before implementation. This PR delivers the spec + recommendation; the verbs land in follow-ups once Q1–Q5 are answered.
