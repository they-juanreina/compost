# Dogfood findings — the "Edges and Ecotones" replication study

Status: **complete** · Date: 2026-06-11 · Build: `feat/codebook-slice-1` ([#260](https://github.com/they-juanreina/compost/pull/260)) · Corpus: [Edges and Ecotones: Donna Haraway's Worlds at UCSC](https://escholarship.org/uc/item/9h09r84h) (Haraway interviewed by Irene Reti, 2007, UCSC Regional History Project)

> **Point-in-time record (2026-06-11).** The "Untested by design" items below were the deferred slices *as of this run*; most have since shipped (codebook-scoped agreement/saturate, cross-lens themes, categories — v0.2.0) and the `codebook duplicate | merge` verbs landed in **v0.2.1** (see [`dogfood-edges-ecotones-duplicate-merge.md`](./dogfood-edges-ecotones-duplicate-merge.md) for their validation). Read the list as history, not current limitations.

This is the seam record from running the codebook/multi-lens model end-to-end on a real oral-history interview — the validation called for by [ADR 0001](./adr/0001-codebook-multiplicity.md)/[0002](./adr/0002-category-tier.md), retargeted from the grounding-literature texts (which are design rationale, not data) to a primary interview. The reproducible walkthrough is the wiki page *Replication Study — Edges and Ecotones*; this doc records what actually happened on one machine, so the seams are written down rather than rediscovered.

## What ran (and worked)

| Step | Result |
|---|---|
| `compost init edges-ecotones --question "…"` | Scaffolded; `codebooks/` dir present; **question rendered into seed.md**; no `events.sqlite` yet (pure scaffold). |
| Drop transcript PDF → `compost watch --once` | Legacy-ingest (native venv) normalized the PDF → **session S001, 107 paragraph-utterances**; embed worker wrote **321 chunks / 214 vectors** to LanceDB via Ollama `bge-m3`. |
| `compost search "feminist theory History of Consciousness"` | **8 grounded hits** of real interview content (no LLM — pure hybrid retrieval). |
| `compost codebook new epistemology --stance framework` + `pluriversal-justice --stance framework` | Two lenses coexist over one corpus; both `framework`-stance; listed by `codebook list` (primary shown as implicit). |
| `compost create highlight … / create code … --codebook <lens>` | 4 highlights + 4 codes (2 per lens). Each code's frontmatter + create event carries the right `codebook_id` (`CB-epistemology` / `CB-pluriversal-justice`). |
| Endorsement gate (AI draft → endorse) | An `--ai` code draft landed `[draft]` (create/ai); a **distinct** researcher endorsed it → lineage chained to `(create ai, endorse researcher)`; self-endorse refused. |
| `compost saturate` | Ran; **recommendation `pause`** on a single session (see seam 4). |
| `compost export --format prov` | W3C PROV-O / PROV-AGENT: **13 entities, 15 activities, 6 agents**; node types include `provagent:AIAgent`, `provagent:AIModelInvocation`, `provagent:AgentTool`, `prov:Person` ×3. **Codebook create events appear as `prov:Activity` and codebook artifacts as `prov:Entity`** — the slice-1 additions survive the standards export and are externally citable. |

**Success criteria met:** two stance-declared codebooks over one corpus; codes carry `codebook_id` in frontmatter + events; `blame`/`endorse` round-trip on `CB-…` refs; PDF→search is grounded; the endorsement gate routes AI drafts through a distinct human; PROV-O carries the codebook layer; `status`/`saturate` do not regress on a multi-codebook seed.

## Observed seams

1. **Text PDFs aren't diarized.** The 107 utterances are all attributed to a single speaker `S1`; the turn labels (`Reti:`, `Haraway:`) live *inside* the paragraph text. For a two-speaker oral history this means speaker attribution is not addressable as structured data. *Implication for the data model:* ADR 0001's note stands — for sourced-document corpora, standpoint is carried by codebook **stance** + (future) a source/author field, not by a diarized speaker. A `speaker`-from-inline-label heuristic for legacy ingest is a candidate follow-up.

2. **PDF running headers pollute paragraph-utterances.** Every page's header ("…Worlds at UCSC N") is absorbed into the paragraph utterances, so naive keyword anchoring lands on header fragments. Coding still works (highlights anchor to real spans), but a legacy-ingest header/footer stripper would materially improve utterance cleanliness. Follow-up candidate.

3. **The similarity scanner saw `embedded_highlights: 0`** even after a second `watch --once`. Highlights are created as `.md` only — there are no per-highlight embedding sidecars in `highlights/`, which is what `compost rescan`/`compost code` read. So on this corpus the scanner could propose nothing, and the endorsement gate had to be exercised with a direct `--ai` draft instead of a scanner suggestion. This is the same threading gap as the known `ChunkMetadata.code_ids[]` backfill (audit claim 10): **artifacts created after the ingest-time embed pass aren't re-embedded into the surfaces downstream consumers read.** Highest-value follow-up surfaced by this study — it blocks AI-proposed codes *and* AI-proposed categories (the centroid work in ADR 0002 depends on code/highlight embeddings existing).

4. **Single-interview saturation is degenerate by construction.** `saturate` ran and returned `pause` over one session — there's no novelty curve to read from a single session. Expected; saturation is a multi-session measure. Worth a clearer "insufficient sessions" signal (mirroring `agreement`'s `insufficient` gate) rather than a bare `pause`. Minor follow-up.

5. **`export --format prov` emits to the response `content` field, not a file.** `exports/` stayed empty; the JSON-LD is returned inline. Fine for an agent piping JSON, surprising for a researcher who expects a file in `exports/`. Doc/UX nit.

## Untested by design (deferred slices — not failures)

These are out of scope for slice 1 and were intentionally not exercised:

- **Cross-lens themes** — themes have no `codebook_id` yet (theme `evidence[]` restructure is the deferred breaking change, ADR 0002).
- **`agreement --codebook` / per-lens κ** — `--codebook` scoping is the deferred scoping slice; on a multi-codebook seed agreement would currently pool lenses.
- **Category creation + endorsement**, **`codebook merge|fork|import`** — stubbed.
- **Centroid-based category suggestion** — blocked behind seam 3 (needs code/highlight embeddings) plus the category artifact.
- **In-vivo enforcement** — stance is stored, not enforced.
- **Codebook-filtered retrieval** — hollow until the seam-3 backfill lands.

## Replication note

The wiki walkthrough (*Replication Study — Edges and Ecotones*) is written to be machine-independent: it fixes the **lenses, code names, definitions, and stances** (so independent coders produce *comparable* codebooks) but drives highlighting through `compost search` rather than hard-coded utterance ids (which depend on the exact PDF rendering). What should be **identical** across machines: event actions, artifact shapes, `codebook_id` stamping, provenance lineage, PROV-O structure. What will **vary**: embedding-model version → retrieval ranking and exact hits; any LLM-assisted step (none required here). Once `--codebook` scoping + `compost recode`/`agreement` land, two researchers independently following the page becomes compost's real cross-team replication test (κ/α within a shared lens).
