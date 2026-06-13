# ADR 0001: Codebook multiplicity (1:n codebooks per Seed)

- **Status:** Accepted (amended against the codebase, 2026-06-11 — see [§ Amendments](#amendments-from-the-codebase-audit))
- **Date:** 2026-06-10
- **Deciders:** Juan (maintainer)
- **Amends:** [ROADMAP §"Data model"](../../ROADMAP.md#data-model), §"Learning mechanisms" (codebook reuse)
- **Related:** `compost agreement`, `compost recode`, `compost saturate`, the three-actor provenance model, [audit report](../codebook-category-audit.md)

## Context

The ROADMAP data model reads as one codebook per seed:

```
Seed (1) ──< Session, Glossary, Codebook, Theme, Insight, EventLog   # Codebook implicitly 1:1
Highlight (1) ──< Code (n via join)
Code (m) ──< (n) Theme       # no tier between Code and Theme
```

A codebook is, ontologically, a *namespace of code definitions over a corpus* — i.e. a **lens** or **frame**: a way of seeing the data. The design question is whether a Seed has exactly one such frame or may hold several coexisting frames over the same sessions.

The decision sits on a real tension, not a preference:

- **Plurality (many frames).** Multiple valid interpretive worlds can coexist over one corpus — emic vs. etic, inductive vs. a-priori/deductive, a usability reading vs. a justice reading, or a fresh reanalysis of a legacy corpus by a new researcher. Forcing these into one namespace muddies all of them. (Escobar, *Designs for the Pluriverse* — "a world where many worlds fit"; Haraway, *Situated Knowledges* — a single codebook implies a single, unmarked standpoint, the "god trick".)
- **Agreement (one shared frame).** Inter-rater reliability (`compost agreement`: Cohen's κ, Krippendorff's α) and blind double-coding (`compost recode`) are only *defined* when two coders apply the **same** frame. Grounded-theory practice treats the codebook as the **consensus artifact** that divergent open coding is meant to collapse into. Unconstrained multiplicity silently breaks features compost already ships and discourages the convergence that produces findings.

A naive "many codebooks" answer sabotages κ/α and saturation; a naive "one codebook" answer forecloses the pluriversal reading half the project's grounding literature argues for. The resolution must be structural.

## Decision

**A Codebook is a first-class artifact. A Seed may hold `1:n` codebooks, and defaults to a single one (`primary`). Agreement and saturation are scoped *within* a codebook.**

Specifically:

1. **Codebook is first-class** (`artifact_kind=codebook`, create/update events) and declares a **stance**: `inductive | deductive | in_vivo | framework`. This stance field makes each frame's standpoint explicit rather than implicit — Haraway's "situated knowledge" operationalized as a required field.
2. **Codes are codebook-scoped.** `Code` carries `codebook_id` in its create payload; a code reference is `(codebook_id, code_id)`.
3. **A Highlight can be coded across multiple codebooks at once.** The same passage may carry, e.g., a usability code and a justice code in parallel frames. Retrieval chunk metadata (`code_ids[]`) becomes codebook-qualified.
4. **Categories are codebook-internal.** A category groups codes within one frame ([ADR 0002](./0002-category-tier.md)).
5. **Themes carry an optional `codebook_id`:**
   - non-null → **frame-internal** theme; subject to κ/α agreement.
   - null → **cross-lens synthesis**; must cite evidence from **≥2 distinct codebooks**; held accountable through the **endorsement gate**, not agreement-measured.
6. **`agreement`, `recode`, and `saturate` operate within a codebook** (`--codebook`, default `primary`).
7. **Default stays simple.** `compost init` creates one `primary` codebook; all coding verbs default to it. Multiplicity is opt-in: `compost codebook new <name> --stance <stance>`. The schema carries `codebook_id` everywhere from day one; the surface only exposes it when asked.
8. **Migration:** existing codes are assigned `codebook_id = primary`.

### Why the optional-`codebook_id` theme model is the keystone

It splits themes into two trust regimes that map directly onto the epistemology:

- **Frame-internal themes** → objectivity-as-consensus is available → measure it (κ/α).
- **Cross-lens themes** → no shared frame, so inter-rater reliability is undefined by construction → fall back to situated accountability (human endorsement).

This is "agreement where frames are shared, accountability where they aren't" — Haraway's argument emerging from the schema rather than bolted onto it.

## Amendments (from the codebase audit)

The original ADR was written without code access. The [audit](../codebook-category-audit.md) confirmed the decision is sound and corrected the following premises:

1. **There is no Codebook artifact today — this ADR *introduces* it, rather than relaxing a 1:1.** `Seeds/<seed>/codebook/` is a directory of per-code markdown files (`createCode`, `cli/src/lib/artifacts.ts`); the ROADMAP's `codebook/codebook.md` never materialized, and no `codebook` artifact kind exists in the event log. The "implicitly 1:1" reading was of the ROADMAP diagram, not of running code.
2. **The event vocabulary is six actions, not four.** `create | update | endorse | reject | link | unlink` ([`schema/events.schema.json`](../../schema/events.schema.json)). The original text claimed everything was expressible with four; the two it omitted — `endorse`/`reject` — *strengthen* this ADR: the cross-lens trust regime (decision §5) rests on an endorsement gate that is already implemented, including self-endorse prevention (`cli/src/lib/artifacts.ts`). A cross-lens theme's accountability chain is auditable today via `compost blame`.
3. **Stance enum spelling:** `in_vivo` (underscore), matching the CLI's validation constant.
4. **Slice-1 constraint (deliberate):** code ids stay `C-<slug>`, unique per seed, flat under `codebook/`. The compound `(codebook_id, code_id)` reference becomes necessary only when `codebook merge|fork|import` allow the same code name in two frames; events carry `codebook_id` from day one, so the compound ref can be introduced then without data loss.
5. **Prerequisites this ADR depends on that do not exist yet** (tracked as work items, see audit §Sequencing):
   - `--codebook` scoping on `agreement`/`recode`/`saturate`. Until it lands, agreement on a multi-codebook seed **silently pools lenses** — methodologically suspect once frames overlap. Known limitation; flagged in the replication-study findings.
   - Codebook-qualified retrieval metadata. `ChunkMetadata.code_ids[]` exists but is only populated at transcript-ingest time (`retrieval/src/chunker.ts`) — codes created later never reach chunk metadata. Codebook-filtered retrieval is hollow until a backfill loop exists.
   - In-vivo *enforcement* (validating an `in_vivo` code name verbatim against evidence, reusing the citation validator in `@they-juanreina/compost-retrieval`). Slice 1 stores the stance; it does not enforce it.
   - Category suggestion needs only *plumbing*, not new math — `meanVector`/centroid-assignment clustering already exist in `retrieval/src/clustering.ts` (see [ADR 0002](./0002-category-tier.md) amendment §3).
   - `compost init --question` (lands with slice 1; the dogfood plan uses it).

## Data-model impact

```
Seed (1) ──< Codebook (n)                 # introduced as a first-class artifact
Codebook (1) ──< Code (n)                 # Code gains codebook_id (default CB-primary)
Code (1) ──< Category-link (n)            # Category is first-class (ADR 0002)
Highlight (1) ──< Coding (n)              # a Coding references (codebook_id, code_id)
Theme.codebook_id  NULLABLE               # null = cross-lens synthesis
Insight ── derived from Theme + Highlight evidence
          # cross-lens Insight carries per-cited-code codebook_id (triangulation provenance)
```

New/changed fields, all expressible with the existing six event actions:

- `codebook`: `{ id, seed_id, name, stance, description }`
- `code.payload += { codebook_id, ... }`
- `theme.payload += { codebook_id?: string|null }`
- validation rule: `theme.codebook_id == null ⇒ distinct(cited codebook_ids) ≥ 2`

## Consequences

**Positive**

- Plurality is *possible* (Escobar) while every frame *declares its standpoint* (Haraway).
- κ/α and saturation become **better-defined**, not weaker: a deductive frame (bounded by its framework) and an inductive frame (open-ended) saturate differently, and are now measured separately.
- **Triangulation provenance:** `blame` on a cross-lens Insight visibly names the frames it fuses — a provenance feature with no SaaS equivalent.
- Improves the ROADMAP's existing "stable codebooks emerge / addressable from siblings" goal: a first-class codebook with identity + stance can be **forked/imported** into another seed and becomes a shareable, citable coding frame — the team-adoption seam.

**Negative / risks**

- Cognitive overhead; risk of researchers spawning lenses instead of converging.
  - *Mitigations:* default-single `primary`; `compost codebook merge` (safe because reject archives, never deletes); agreement only works within a frame, so the reliability tooling itself rewards convergence where it matters.
- `Insight` derivation gains one case (cross-lens). Accepted in exchange for productive (not merely parallel) plurality.
- Until `--codebook` scoping lands, agreement pools lenses (amendment §5).

## Alternatives considered

1. **Lens as a tag/facet on codes** (no container). *Rejected:* a lens needs its own namespace (two frames can both have a code "distrust" meaning different things), its own metadata (stance, owner, saturation state, agreement scope), and its own lifecycle. A tag carries none of that.
2. **Codebook = Seed (1:1); achieve plurality by spawning sibling seeds over shared sessions.** *Rejected:* a Seed is a research *question*; a lens is a new *reading* of the same question. This duplicates/awkwardly shares sessions and mis-models the unit.
3. **Strictly frame-scoped themes (no cross-lens).** *Rejected (deferred option):* simpler `Insight` chain, but loses the integrative finding that triangulates frames — the main payoff of plurality.

## Downstream

- [ADR 0002](./0002-category-tier.md) — Category tier design.
- Split/merge as first-class event actions vs. composed from create/relink/reject.
- In-vivo name validation reusing the citation validator.
- `compost codebook` verb surface (`new | list | migrate` in slice 1; `migrate-ids` in v0.2.0; `duplicate | merge` shipped v0.2.1 — `fork`+`import` collapsed into `duplicate`, was `merge | fork | import`).
- Replication study: [wiki walkthrough](https://github.com/they-juanreina/compost/wiki) on the "Edges and Ecotones" Haraway oral history exercises two coexisting framework-stance codebooks end-to-end.

## References (project grounding corpus)

- Escobar, *Designs for the Pluriverse* — pluriversality; ontological design.
- Haraway, *Situated Knowledges* — situated/partial objectivity; accountability vs. the god trick.
- Saldaña, *The Coding Manual for Qualitative Researchers* — codebook, first/second-cycle coding, operational definitions.
- Latour & Woolgar, *Laboratory Life* — construction and stabilization of facts (informs the endorsement gate).
