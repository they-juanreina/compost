---
name: analytic-memos
description: Write and link analytic memos in a compost seed — the analyst's dated, evolving interpretive record (Saldaña's "site of conversation with ourselves about our data"; ADR 0004). Draft a memo grounded in real evidence (a code memo, a theme memo, a reflexive/positionality note, a method/audit note), anchor it to what it's about, and leave it as a [draft] for the researcher to endorse. Use whenever the user wants to memo, journal, jot an analytic note, capture reasoning behind a coding decision, record reflexivity/positionality, or write up why codes/themes hang together. Memos can themselves be cited as theme evidence ("memos are data"). The verbs live in `compost memo`.
---

# analytic-memos

A **memo** is the analyst's running interpretive record — *why* a move was made,
not just that it was. Saldaña: "codes… are nothing more than labels until they
are analyzed"; the memo *is* the analysis. compost holds and versions the memo
under full provenance; it does **not** author the interpretation. So an
AI-drafted memo is a **proposal**: it lands `[draft]` and stays untrusted until a
researcher endorses it. Never self-endorse your own draft.

## Verbs

- `compost memo new "<title>" --content "<text>" [--type <t>] [--anchor kind:ref …] [--codebook <ref> | --cross-frame]`
  — write a memo. `--type` ∈ `code | category | theme | reflexive | method |
  theory | freeform` (default `freeform`). Repeat `--anchor` to point at what the
  memo is about: `code:distrust`, `theme:T-x`, `category:CAT-y`, `highlight:H-001`,
  `codebook:CB-z`, or `memo:M-w` (a metamemo). Zero anchors = a project-level
  reflexive memo.
- `compost memo list [--about <ref>] [--type <t>] [--codebook <ref>]` — list
  memos; `--about` is the backward link (every memo anchored to a code/theme/…).
- `compost memo view <M-id>` — read one memo's current state.
- `compost memo edit <M-id> [--content <text>] [--type <t>]` — revise it; each
  edit is an `update` event, so the ledger carries the evolution (Saldaña's "dated
  snapshots"). **Researcher act** — do this on the human's behalf only when asked.
- `compost memo cite <M-id> --anchor kind:ref …` — anchor the memo to more of the
  workflow (ATLAS.ti's "link a memo across the workflow"). **Researcher act.**
- `compost endorse <M-id>` / `compost reject <M-id>` — the **top-level** verbs
  (a memo is endorsed like any artifact). Endorsement is the *researcher's* gate.

Via MCP: `compost_create_memo` (drafts → `[draft]`) and `compost_list_memos`
(read). Editing, citing, and endorsing are CLI/researcher acts — not agent tools.

## Drafting a good memo (the AI-assist flow)

1. `compost memo list --seed <name> --json` to see what's already memoed, and
   `compost memo list --about <ref>` to read prior notes on the artifact you're
   about to memo (don't duplicate the analyst's thinking).
2. Ground it. A memo worth keeping cites the data: pass `--anchor` for the codes,
   highlights, or themes it reflects on. An anchored memo is auditable; a
   free-floating one is just an opinion.
3. Pick the `--type` honestly: `code`/`theme` (about a specific artifact),
   `reflexive` (your positionality / how your stance shapes the reading),
   `method` (a decision for the audit trail), `theory` (linking to the
   literature), `freeform` otherwise.
4. Write it as a *proposal*. It lands `[draft]`. Tell the user it's there and
   that endorsing it is their call: `compost endorse <M-id>`.

## The boundary (read this)

This is the line compost will not cross (§2 "not the analyst"):

- **Propose, never assert.** A drafted memo is a suggestion behind the endorse
  gate. Do not present it, or act on it, as a settled finding. Do not endorse it
  yourself — the CLI refuses a self-endorse, and you shouldn't try.
- **Anchor, don't editorialize.** A memo should reason *from* cited evidence. An
  unanchored "here's what this transcript means" dropped in as truth is exactly
  the interpretation compost must not own — leave that judgment to the human.
- **Memos are not corpus.** They're interpretation, so they're deliberately kept
  out of `compost search` / grounded chat retrieval. Find them with `compost memo
  list --about`, not by searching the corpus.

## Memos as data

A memo can itself be cited as theme evidence
(`compost create theme … --evidence memo:M-x`) — Saldaña's "memos are data." Such
a memo is a frame-neutral annotation: it's recorded as support but contributes no
codes to saturation / agreement (a memo is not a participant utterance). Use it to
show a finding rests partly on the analyst's reasoning, without inflating coverage.

## Verifying

`compost memo view <M-id>` shows current state (including `human_approved`);
`compost blame <M-id>` prints the lineage (create → edit → endorse). The artifact
model, the `[draft]`→endorse gate, the anchor/codability rules, and the
no-inflate invariant live in `cli/src/lib/memos.ts` + `artifacts.ts` and are
covered by `memos.test.ts`.
