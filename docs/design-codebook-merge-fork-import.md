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

- **fork `<source>` `<new-name>`** — create codebook `CB-<new-name>` (copy stance/description), then for each non-archived code in `<source>` emit `create(code, …, codebook_id=CB-<new-name>)` with a fresh artifact id (the SHA changes with the frame) and an `inputs`/note linking the origin code for `blame` lineage. Category links within the source are **not** copied (a fork is a fresh second-cycle pass). *(Decided: fork branch-copies the codes.)*
- **merge `<from>` `<into>`** — re-emit each of `<from>`'s codes as belonging to `<into>` (an `update(codebook_id)` event, preserving artifact identity + history), then **reject-archive** `<from>` (never delete — `reject` archives, ADR 0001). Colliding names resolve via the chosen compound ref; coverage math (saturate, agreement) must treat the two as distinct until/unless the researcher explicitly de-dupes.
- **import `<seed>` `<codebook>`** — copy the codebook artifact + its codes' create events into this seed as a new frame, preserving their original `codebook_id` lineage in `inputs` for citation. Cross-seed highlight evidence does **not** travel (the highlights live in the other seed) — an imported code arrives as a *definition-bearing frame*, evidence re-attached locally. *(Decided: frame + definitions only; an evidence-less imported code is valid.)*

## Decisions (maintainer, 2026-06-12)

| # | Question | Decision |
|---|---|---|
| 1 | Ref scheme | **A — namespaced id + path.** Codes live at `codebook/<CB-slug>/<code-slug>.md`; canonical id is `C-<cb-slug>/<code-slug>`. A bare `C-<slug>` is accepted as shorthand and resolved against its frame. |
| 2 | `fork` | **Branch** — copy the source codebook's codes into the new frame (fresh ids, origin linked for `blame`). |
| 3 | `import` | **Frame + definitions only** — evidence stays in the origin seed; re-attached locally. |
| 4 | `merge` | **Keep distinct** — same-named codes are never silently fused; de-dup is a later explicit action. |
| 5 | Bare-`C-slug` tie-break | **Error-and-list** when a bare ref is ambiguous across frames (mirrors `resolveCategory`). |

Option A is the cleanest end state — the id is self-describing, collisions are impossible *across* frames by construction, and the filesystem mirrors the frame structure — at the cost of a **seed-wide migration** of every existing `C-<slug>` ref. That migration is the bulk of the work and is why this lands as a dedicated effort, not inline.

### The merge wrinkle Option A does not erase

Option A removes cross-frame collisions, but **`merge` collapses two frames into one**, and within a single frame `codebook/<cb>/<slug>.md` is still one-slug-per-dir. So merging `CB-a` and `CB-b` when both coded `distrust` produces two codes that must coexist *in the same frame* — which the flat per-frame dir can't hold. With **keep-distinct**, `merge` must rename one on the way in (e.g. `distrust` ← from `CB-a`, `distrust-from-b` ← from `CB-b`) and record the rename in the event log so `blame` shows it. `merge` therefore remains the highest-risk verb: it touches coverage math (saturate/agreement see two distinct codes) and needs the within-frame disambiguation rule.

## Build plan (dedicated follow-up — seed-wide ref migration)

This is effectively its own mini-milestone; sequencing to keep each step reviewable:

1. **`resolveCodeRef(seed, ref) → {id, codebook_id, path}`** — the single choke point. Accepts the qualified `C-<cb>/<slug>` and the bare `C-<slug>` (error-and-list when ambiguous). *Every* consumer that today builds `codebook/<slug>.md` or parses `C-<slug>` routes through it: `createCode`, `saturate`, `categories`, `recode`, `agreement`, `blame`, `embeddedHighlights`, retrieval `code_ids`, web, MCP.
2. **Storage migration** — move existing flat `codebook/<slug>.md` → `codebook/CB-primary/<slug>.md`, stamp the qualified id, emit update events; extend `compost codebook migrate`. Bare-ref shorthand keeps old refs (themes `evidence`/`codes`, category links, retrieval `code_ids`) resolving without a rewrite.
3. **`import`** (lowest risk — different seed, different frame dir, no collision).
4. **`fork`** (branch-copy into a new frame dir).
5. **`merge`** (highest risk — within-frame disambiguation + coverage math).

Each step gets the same adversarial review + regression tests as the rest of the milestone. Note left in place as the spec of record; PRs reference it.

## Why this stayed a design note until now

Un-stubbing these verbs without settling the ref scheme would have baked a guess into every code-referencing consumer (themes, categories, recode, agreement, blame, retrieval) — the genuinely ambiguous data-model decision that warranted the maintainer's call. With Option A chosen, the build plan above is unblocked.
