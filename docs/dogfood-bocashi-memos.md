# Dogfood — does a real two-lens study exercise analytic memos end-to-end?

Status: **complete** · Date: 2026-06-14 · Build: `cli` dev bin (milestone #9 branch) ·
Corpus: [bocashi-dogfood-study](../../Compost%20(1)/bocashi-dogfood-study) (synthetic
urban-agroecology study — 14 interviews, two lenses) · Milestone:
[#9](https://github.com/they-juanreina/compost/milestone/9) · Design + gate:
[`design-analytic-memos.md`](./design-analytic-memos.md), ADR 0004.

This closes the validation step the memo gate named: *"the first natural validation
is to write real memos against a study the moment the keystone slice lands."* It
walks **every memo capability** on a realistic two-lens study and reports what
fired. The data is **synthetic** (the kit is built to trigger code paths, not to be
true), so this validates the **workflow, ergonomics, and invariants end-to-end** —
not an independent researcher's felt need (that remains the recorded maintainer
override plus a future real study, e.g. Edges & Ecotones).

## Method

Built a real seed from the kit's coding scheme (two codebooks —
`practical-logistics` inductive, `agroecology-values` framework — a few codes, a
theme) and ran the full `compost memo` surface against it with the local
embeddings provider (Ollama) up. Each step below is what actually ran.

## Findings — every capability fired

| # | Capability | Result |
|---|---|---|
| 1 | **Brain-dump, no title** (`memo new "<content>" --type theme --anchor code:pest-and-ph`) | Created `M-001` at `synthesis/memos/M-001.md` — mechanical id, no title required. |
| 2 | **Embedding-extractive title** (`memo retitle M-001`, local Ollama) | Computed a `suggested_title` from the body (the representative sentence, clipped); `memo view` shows it as `display_title`. The extractive path ran on real local embeddings. |
| 3 | **Titled reflexive memo + anchor** (`--title … --type reflexive --anchor code:food-sovereignty`) | `M-002` (sequential). |
| 4 | **Full-text search** (`memo list --text "fruit-fly"`) | 1 hit (`M-001`) — memos are searchable as their own facet, never the grounding corpus. |
| 5 | **Backward link** (`memo list --about pest-and-ph`) | `[M-001]` — the memo anchored to that code. |
| 6 | **AI-draft → endorse gate** (`memo new … --ai`, then `compost endorse M-003`) | `M-003` born `human_approved=false`; a second-actor `endorse` flipped it true. |
| 7 | **Memo as theme evidence** (`create theme … --evidence code:food-sovereignty,memo:M-003`) | Theme created; the memo rides as frame-neutral support, excluded from coverage math (no-inflate). |
| 8 | **Merge reference-guard (#318)** (`codebook merge practical-logistics agroecology-values --apply`) | **Refused**, naming the blocking referrers: *"codes … are woven into higher tiers (themes T-run-by-the-senses; **memos M-001**)."* A memo-anchored code can't be silently re-homed. |
| 9 | `compost status` | `memos: 3`. |

The decoupled identity (#314) showed its value directly: the title-less brain-dump
(#1) and the retitle (#2) only work because the id is mechanical, and step 8's guard
keys on the anchor, not the title.

## Kill-filter re-confirmation (CLAUDE.md pre-flight)

| # | Check | Verdict |
|---|---|---|
| 1 | Reachable without compost? | **No** — only compost gives the memo provenance (the AI-draft→endorse lineage in #6), the dated ledger, the codable backward-link (#5), and the referential guard (#8). **Pass.** |
| 2 | Not the analyst? | **Pass** — every AI memo is a `[draft]` behind the human gate (#6); `retitle` is *extractive* (selects a verbatim span), not generated prose; memos stay out of grounded chat. |
| 3 | Human stays free (CLI, offline)? | **Pass** — the whole tour is CLI; only `retitle` needs the (local) embeddings provider, and it degrades to the first-line title when absent. |
| 4 | Validated need? | **Workflow demonstrated** on a realistic two-lens study. The *need* itself rests on the recorded grounding override (Saldaña + ATLAS.ti + ADR 0002's forward-reference); independent felt-need validation on a non-synthetic study is still owed. |

## Replication

From the kit dir, with the milestone-#9 `compost` build on PATH:
`bash dogfood-run.sh` (the memos section, "9. ANALYTIC MEMOS") reproduces 1–8;
`compost status --seed compost-study` shows the memo count. Findings 2 needs Ollama;
without it, `retitle` is a no-op and `display_title` falls back to the first line.
