# ADR 0002: Category tier (second-cycle / pattern-coding layer)

- **Status:** Accepted (amended against the codebase, 2026-06-11 — see [§ Amendments](#amendments-from-the-codebase-audit))
- **Date:** 2026-06-10
- **Deciders:** Juan (maintainer)
- **Depends on:** [ADR 0001 — Codebook multiplicity](./0001-codebook-multiplicity.md)
- **Amends:** [ROADMAP §"Data model"](../../ROADMAP.md#data-model) (`Code (m) ──< (n) Theme`)
- **Related:** cross-session-similarity scanner, `compost saturate`, Memo artifact (separate ADR, future), [audit report](../codebook-category-audit.md)

## Context

The data model jumps straight from codes to themes:

```
Code (m) ──< (n) Theme
```

This collapses Saldaña's **two coding cycles** into one. First-cycle codes (descriptive, in vivo, process, …) are supposed to be grouped, in a second cycle, into **categories / pattern codes** before they become themes. Without that middle rung, the interpretive move of "these codes belong together, and here's why" has nowhere to live, no definition, and no provenance — and saturation can only be measured on raw code counts rather than on conceptual coverage.

## Decision

**Add `Category` as a first-class artifact — a codebook-internal grouping of codes — sitting between `Code` and `Theme`. The layer is optional.**

1. **First-class artifact, not a field.** `artifact_kind=category`, with create/update events; grouping is expressed via existing `link` / `unlink` actions (`link(code → category)`). A `parent_category` field on `Code` was rejected because it cannot carry provenance — and grouping is exactly the kind of interpretive act the AI proposes and a human endorses.
2. **Codebook-internal.** A category belongs to one codebook (inherits the frame); it groups only codes within that frame.
3. **Cardinality: m:n with a designated primary.** A code may link to several categories (supports axial relationships), but exactly one link per code is flagged `is_primary` for coverage/saturation math. Orphan codes (no category) and multi-home codes (>1 category) are valid states the UI surfaces for review.
4. **Optional middle layer.** A `Theme`'s evidence is a heterogeneous set of `{code | category}` refs. Rich analyses use the full `code → category → theme` ladder; light studies may go `code → theme` directly. Categorization is never forced.
5. **Definition + memo.** Like `Code`, a `Category` carries a `definition` (what unifies these codes). Categorization is where analytic memoing intensifies, so a Category is a natural attachment target for a Memo (see Memo ADR, future).

## Amendments (from the codebase audit)

The original ADR was written without code access. The [audit](../codebook-category-audit.md) confirmed the decision and corrected the following premises:

1. **Theme evidence is the one breaking change in the ADR set.** Today a Theme's payload is `{id, kind:'theme', name, summary, codes[]}` (`createTheme`, `cli/src/lib/artifacts.ts`) — there is no `evidence` field. Moving to heterogeneous `evidence[{kind: code|category, ref, codebook_id}]` restructures the payload, and **`compost saturate` must be rewired**: it currently joins `theme.codes → code.evidence → highlight.session_id` (`cli/src/lib/saturate.ts`). The rewiring is mechanical (an `evidence` entry of kind `code` resolves as today; kind `category` resolves through its `link` events to member codes) but it is not additive. **Deferred past slice 1**; existing `codes[]` themes migrate as `evidence: codes.map(c => ({kind:'code', ref:c, codebook_id}))`.
2. **Link payloads already exist as a mechanism.** `compost recode` writes link events with payload `{code, highlight, blind: true}` (`cli/src/lib/recode.ts`) — `is_primary` extends an established pattern rather than introducing one.
3. **The centroid primitive already exists; the category-suggestion application doesn't.** `retrieval/src/clustering.ts` ships `meanVector` and a `clusterByEmbedding` that assigns items by cosine similarity *to the cluster centroid* (pairwise cosine is only the cohesion metric) — the scanner uses it over highlight vectors (`suggestCodeClusters`, threshold 0.75, via `cli/src/loops/synthesis.ts`). What's missing is the level-up application: representing each **code** as the centroid of its evidence-highlight embeddings and clustering those code-centroids. New plumbing reusing existing math — a prerequisite for AI-proposed categories, tracked as a work item.
4. **The two review states (orphan, multi-home) land in the web UI when the category slice lands** — the v0.2 web package reads snapshots via the engine, so both states are queryable from link events without new storage.

## Data-model impact

```
Codebook (1) ──< Category (n)
Category (1) ──< code-link (n)        # link(code → category), one flagged is_primary
Code (1) ──< code-link (n)            # a code may appear in several categories
Theme.evidence = [{kind: code|category, ref, codebook_id}]   # heterogeneous, optional ladder
```

- `category`: `{ id, codebook_id, name, definition }`
- code↔category link payload: `{ is_primary: bool }`
- `theme.payload.evidence`: list of `{kind, ref}` where `kind ∈ {code, category}`
- All expressible with the existing six event actions (`create | update | endorse | reject | link | unlink`).
- **Migration note (supersedes the original "non-breaking" claim):** existing `theme.codes[]` remains *readable* during a deprecation window via lazy mapping to `evidence[]`; `saturate` and `synthesize` consumers are updated in the same change. Additive for codes; restructuring for themes.

## Category suggestion = clustering in code-embedding space

The cross-session-similarity scanner already suggests codes and drafts candidates for un-coded clusters. Extend the same mechanism one level up:

- Cluster **codes** by their aggregate evidence embedding (the centroid of the utterances/highlights each code covers) — *reuses `meanVector`/`clusterByEmbedding` from `@they-juanreina/compost-retrieval`; the code-centroid plumbing is the new part, see amendment §3*.
- Each dense cluster → `create(category, actor=ai, [draft])` + proposed `link(code → category, [draft])`.
- The researcher keeps / moves / rejects each link.

Because every link is its own event, `blame` on a category reads as a lineage: *"AI grouped these 5 codes; researcher kept 4, reassigned 1."* Second-cycle coding gains the same three-actor provenance as first-cycle.

## Consequences

**Positive**
- Restores Saldaña's two-cycle structure; the "why these belong together" move becomes a definable, provenance-bearing artifact.
- **Saturation gets a real denominator:** coverage measured as "category C represented in N of M participants," not raw code count. Feeds `compost saturate --codebook`.
- Embeddings do analytic work at the second cycle, not just retrieval.
- m:n preserves axial cross-grouping; the `is_primary` flag keeps coverage math unambiguous.

**Negative / risks**
- Two new review states (orphan, multi-home codes) the UI must surface.
- `Theme` / `Insight` derivation must handle a heterogeneous `{code | category}` evidence set rather than a uniform one — including the `saturate` rewiring (amendment §1). Accepted in exchange for not forcing categorization on small studies.

## Alternatives considered

1. **`parent_category` field on Code.** Rejected — no provenance; can't be AI-proposed-then-endorsed.
2. **Strict tree (one parent per code).** Rejected — tidy coverage math but discards axial relationships Saldaña treats as central.
3. **Mandatory three-rung ladder.** Rejected — uniform derivation, but bureaucratic for small studies; Saldaña: not every code becomes a category, not every study runs every cycle.

## Downstream

- Memo artifact ADR (Category and Code as memo targets) — future.
- `compost category` verb surface (`new | list | link | unlink | promote-to-theme`) — the category slice, after slice 1.
- Saturation redefinition against category coverage.
- Code-centroid clustering plumbing in `@they-juanreina/compost-retrieval`, reusing `meanVector`/`clusterByEmbedding` (prerequisite, amendment §3).

## References

- Saldaña, *The Coding Manual for Qualitative Researchers* — first/second-cycle coding, pattern codes, categories, axial coding.
- Latour & Woolgar, *Laboratory Life* — provenance of how a grouping (a small fact) gets stabilized.
