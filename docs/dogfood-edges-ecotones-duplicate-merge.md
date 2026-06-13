# Validation — does a real two-lens study reach for `codebook duplicate | merge`?

Status: **complete** · Date: 2026-06-13 · Build: installed `compost` v0.2.0 · Corpus:
[Edges and Ecotones: Donna Haraway's Worlds at UCSC](https://escholarship.org/uc/item/9h09r84h)
(Haraway interviewed by Irene Reti, 2007, UCSC Regional History Project) ·
Issue: [#269](https://github.com/they-juanreina/compost/issues/269) ·
Design note: [`design-codebook-merge-fork-import.md`](./design-codebook-merge-fork-import.md) ·
Prior dogfood (data model): [`dogfood-edges-ecotones-findings.md`](./dogfood-edges-ecotones-findings.md)

This is the **gate** CLAUDE.md and #269 require before un-stubbing the verbs:
*"do not extend without re-testing — run the kill filter on a real two-lens study;
validate the **need** on real data, not in the abstract."* The 2026-06-11 dogfood
validated the *data model* (two stance-declared lenses coexist over one corpus) but
explicitly **deferred** `merge | fork | import` as untested. This pass closes that
gap: it walks the real two-lens workflow to the point where `duplicate`/`merge` would
be reached, and reports honestly whether the need fires.

## Method

Read-only inspection of the canonical `edges-ecotones` seed (no mutation — the verbs
are stubbed, and the real corpus is not a scratchpad). Two framework lenses already
exist over the one interview:

| Lens | Stance | Codes |
|---|---|---|
| `CB-epistemology` | framework | `disciplinary-edges`, `positioned-objectivity`, `situated-standpoint` |
| `CB-pluriversal-justice` | framework | `collective-production`, `interdisciplinary-worlds` |

## Finding 1 — the consumers shipped (the earlier "deferred" list is stale)

The 2026-06-11 doc listed `agreement --codebook`, per-lens `saturate`, and cross-lens
themes as deferred. **They all shipped this milestone** (#264 / #265 / #266 / #285) and
behave correctly on a real two-lens seed:

- `compost agreement --codebook CB-epistemology` → frame-scoped κ, correctly
  `insufficient` (0 doubly-coded units; needs ≥10). κ is undefined across frames, as designed.
- `compost saturate --codebook <lens>` → per-lens novelty curve, correctly `insufficient`
  on one session (the #272 "needs ≥2 sessions" signal landed — seam 4 of the prior dogfood is fixed).
- Cross-lens themes, categories, qualified code ids (`migrate-ids`) — all live.

So the "no consumer yet" objection to building the verbs is gone: the workflows that
*operate on* duplicated/merged frames exist and are frame-aware.

## Finding 2 — the real study does **not** organically reach for either verb

- **`duplicate` was never reached.** Both lenses were authored from scratch via
  `compost codebook new` + independent coding. They are genuinely distinct framings
  (Haraway's situated knowledges vs. Escobar's pluriverse), **not** one branched from
  the other. Nothing in the single-analyst, single-corpus flow wanted "give me a copy
  of this lens to evolve."
- **`merge` would fight this study's design.** The whole point (ADR 0001 / situated
  knowledges / pluriverse) is to hold the two partial standpoints *separately*. Folding
  `CB-epistemology` into `CB-pluriversal-justice` would destroy the multiplicity the
  study exists to preserve. Merge is an *anti-goal* here, not an unmet need.

## Finding 3 — where the need genuinely lives (grounded, but unexercised by this data)

The methodology pass (recorded in the design note) already established the *capability*
is novel — no QDA-canon analogue, grounded in Haraway/Escobar multiplicity rather than
Saldaña's mono-codebook tradition. The two verbs' real homes are real workflows that
the available data simply cannot stage:

- **`duplicate --from` (cross-study framework reuse — Ritchie & Spencer):** the strongest,
  most canonical case. Reuse a validated codebook from study A as a deductive frame in
  study B; the frame travels, evidence does not, the borrowed code enters un-grounded
  and earns local saturation. **Requires a second real study.** None is staged — the
  other seeds in the workspace (`acr`, `dqc`) are 1-code scratch seeds, not reusable frames.
- **`merge` (team convergence to a master codebook — Saldaña p.34):** independent coders'
  frames converge. **Requires a multi-coder team.** This is single-analyst data.
- **`duplicate` (same-seed second lens):** the design note's own narrowest case — if you
  want to keep the coding you edit in place (history preserved via events); duplicate's
  value is the *independent, re-grounded* lens. Speculative; not fired by this study.

## Kill-filter verdict (CLAUDE.md pre-flight)

| # | Check | Verdict |
|---|---|---|
| 1 | Can an agent reach this without compost? | **No** — only compost preserves the append-only re-homing (`update(codebook_id)` + lineage), keeps coverage math correct, and enforces reject-archive-not-delete. Capability is novel. **Pass.** |
| 2 | Not the analyst? | **Pass** — duplicate/merge are structural operations on frames, not interpretations. |
| 3 | Human stays free (CLI, offline)? | **Pass.** |
| 4 | Is the demand validated, or typing for an unvalidated need? | **The demand is methodologically grounded but did not fire on the one real study available.** The scenarios that fire it (a second corpus; a coding team) are absent from the dogfood workspace. |

## Decision (maintainer, 2026-06-13)

Gate #4 came back **"grounded but not demonstrated on the available data"** — not a clean
pass. Presented with three options (park #269 to v0.3; build `duplicate` only; build both),
the maintainer (Juan) chose **build `duplicate` + `merge` and fully close #269**, making the
explicit call that the methodology grounding + ready consumers + ADR 0001 constitute
sufficient validation of the capability, and that the absence of a demonstrating scenario
is an artifact of the single-study dogfood workspace rather than evidence the need is unreal.

This override is recorded here so the reasoning is on the record: the verbs were **not**
built because the kill filter cleared automatically on real data — they were built on a
deliberate maintainer judgment that the grounding is sufficient. The first natural
follow-up validation, when a second real study exists, is `duplicate --from` against it.

## Replication

`compost codebook list --seed edges-ecotones`, `compost agreement --codebook <lens>`,
`compost saturate --codebook <lens>` reproduce findings 1–2 on any checkout of the seed.
Finding 3 is unreproducible *by design* — it names data the workspace does not contain.
