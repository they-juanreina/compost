# ADR 0004: Analytic memos (first-class, codable interpretive artifact)

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Juan (maintainer)
- **Depends on:** [ADR 0002 — Category tier](./0002-category-tier.md)
- **Fulfills:** ADR 0002 §5 / §Downstream forward-reference
  (*"Memo artifact ADR (Category and Code as memo targets) — future"*)
- **Design + kill-filter audit:** [`docs/design-analytic-memos.md`](../design-analytic-memos.md)
- **Milestone:** [#9 — Analytic memos](https://github.com/they-juanreina/compost/milestone/9)

## Context

The data model holds the corpus (`highlight`), the labels (`code`), their
groupings (`category`), and the findings (`theme`) — but not the analyst's
*running interpretive record*: the dated, evolving "why" behind each move.
Saldaña devotes a chapter to analytic memos and is explicit that "codes… are
nothing more than labels until they are analyzed" — the memo *is* the analysis,
and it is "data" that can itself be coded, dated, and searched. ADR 0002 already
reserved the slot. The evidence case and the full kill-filter audit live in the
[design doc](../design-analytic-memos.md); this ADR records the decision.

A memo brushes against compost's core stance — "store and verify, *not* the
analyst." The resolution is that compost **holds and versions** interpretation
under the endorsement gate; it never generates-and-asserts it.

## Decision

**Add `Memo` as a first-class artifact — the analyst's dated, anchored,
provenance-bearing interpretive record — born under the same three-actor model
and `[draft]` gate as every other artifact.**

1. **First-class artifact.** `artifact_kind=memo`, stable id `M-<slug>`, markdown
   at `synthesis/memos/`, SHA256-addressed initial state, atomic write-then-emit
   with the existing six event actions. A free-text field on code/theme was
   rejected: it cannot carry provenance, cannot be dated/versioned as a series,
   and cannot itself be coded.
2. **Researcher-authored; AI may draft, endorse-gated.** A researcher memo is
   trusted on creation; an AI-drafted memo is born `[draft]` and untrusted until
   `endorse`. `reject` archives; `blame` prints lineage; the self-endorse guard
   applies. This is the line that keeps the feature "not the analyst."
3. **Anchors to any artifact, and is itself codable.** A memo cites a
   heterogeneous set `{kind: highlight|code|category|theme|codebook, ref,
   codebook_id?}` (reusing the theme evidence encoding); zero anchors = a
   project-level reflexive memo. Because "memos are data," a `memo` is a valid
   evidence/coding target in turn.
4. **Memos do not inflate coverage math.** A memo cited as evidence is excluded
   from saturation and κ/α (it is not a participant utterance) — enforced in
   `lib`, mirroring secondary-category-link exclusion.
5. **`type` is a constrained set, not a free string.**
   `{code | category | theme | reflexive | method | theory | freeform}`, default
   `freeform` (§9). A reduction of Saldaña's reflection categories to the
   load-bearing few.
6. **Editing is an `update` event; the ledger is the chronology.** Editing emits
   field-level `update`s rather than spawning files; the append-only event log
   natively provides Saldaña's/Birks & Mills' "series of dated snapshots,"
   readable via `blame`.

## Surfaces

One name everywhere (§7): CLI `compost memo new|edit|view|list|cite|endorse|
reject`; MCP `compost_create_memo` (aiAuthored) + list/cite/edit; **web
deferred** (CLAUDE.md live tension — no codebook/memo verbs in the web UI until
that surface is designed).

## Gate

The kill filter (full table in the design doc) clears 1–3; check 4 ("validated
need") came back **grounded-but-not-demonstrated**, against the unretired
addendum live-tension #4 ("thin validation — get a second corpus before adding
apparatus"). The maintainer chose to **proceed on grounding** — the same explicit
override recorded for `codebook duplicate | merge` — with first validation being
real memos written against the Edges & Ecotones seed once the keystone slice
lands. Recorded so the build rests on a deliberate judgment, not an automatic
pass.

## Consequences

**Positive**
- The interpretive trail becomes a provenance-bearing, codable surface — the
  analyst's side of the §13 history-as-trust-surface.
- Closes ADR 0002's open forward-reference; Code/Category/Theme gain a natural
  memo target.
- No new versioning machinery — the event ledger already supplies dated snapshots.

**Negative / accepted**
- More apparatus on still-thin (single-study) validation — accepted via the
  recorded override; revisited when a second corpus exists.
- A new artifact kind threads through `status`, `search`, `export`, `reindex`,
  and the codability join — bounded, mechanical, tracked as milestone-#9 slices.

## Alternatives considered

1. **Free-text `memo` field on Code/Theme.** Rejected — no provenance, no dated
   series, not codable (ADR 0002 rejected the parallel `parent_category` field
   for the same provenance reason).
2. **Researcher-only memos (no AI actor).** Rejected as the *default* — it would
   break symmetry with the rest of the model and forgo useful AI scaffolding; the
   endorsement gate already supplies the needed safety, so AI-draft-then-endorse
   is the chosen path. (The researcher-only stance remains reachable simply by
   not using the AI path.)
3. **Reuse the glossary `term`.** Rejected — the term is UI-only and
   non-persisted; it carries none of provenance, versioning, or endorsement.

## References

- [`docs/design-analytic-memos.md`](../design-analytic-memos.md) — evidence case
  + full kill-filter audit + data model.
- Saldaña, *The Coding Manual for Qualitative Researchers*, Ch. 2.
- Braun & Clarke, Reflexive Thematic Analysis; Haraway (1988); Latour (1983).
- [ADR 0002](./0002-category-tier.md); [North Star](../north-star-humans-and-agents.md)
  §§7–10, 13, 15; [addendum](../north-star-addendum.md) live-tension #4.
