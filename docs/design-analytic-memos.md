# Analytic memos — design + kill-filter audit

Status: **Proposed** (design + gate) · Date: 2026-06-13 · Maintainer decision:
**proceed on grounding** (recorded override, see [§ Decision](#decision-maintainer-2026-06-13)) ·
Milestone: [#9 — Analytic memos](https://github.com/they-juanreina/compost/milestone/9) ·
ADR: [`0004-analytic-memos.md`](./adr/0004-analytic-memos.md) ·
Fulfills the forward-reference in [ADR 0002 §5 / §Downstream](./adr/0002-category-tier.md)
(*"Memo artifact ADR (Category and Code as memo targets) — future"*).

This doc does two jobs the request named — **search for the evidence** that a
first-class memo is necessary, and **audit the feature** against the CLAUDE.md
pre-flight — then records the data model and the slices that become milestone #9.
It is the analogue of the `design-codebook-merge-fork-import.md` + dogfood-verdict
pair, combined: there is no separate dogfood pass because the gate decision
(below) is to proceed on methodology grounding rather than to require a
demonstrating study first.

## The capability in one line

A **memo** is a first-class, provenance-bearing, *codable* artifact that holds the
analyst's evolving interpretive thinking — dated, anchored to the corpus and to
codes/categories/themes, versioned in the event ledger, and (for AI-drafted
memos) gated behind human endorsement like every other AI artifact.

compost **stores and versions** the interpretation; it does not author it. That
distinction is the whole audit (§ [Kill-filter](#kill-filter-audit-claudemd-pre-flight)).

## Why now

ATLAS.ti recently made memos codable and linkable across the workflow — memos
stop being a side-drawer of free text and become objects you can code, cite, and
retrieve like any other. compost has a glossary `term` and code/category
`definition`s, but **no first-class analytic memo**: the running record of *why*
the analyst made each move has nowhere provenance-bearing to live. The forward
reference was already on the books — ADR 0002 §5 named a Category as "a natural
attachment target for a Memo (see Memo ADR, future)" — so this is a planned slot,
not a net-new idea.

## Evidence for necessity (the canon)

The methodology literature treats memoing as load-bearing, not optional, and —
critically for compost's stance — as the **researcher's** interpretive work
product, which is exactly the kind of thing compost should *hold and version*
rather than *generate*.

### Saldaña — *The Coding Manual for Qualitative Researchers*, Ch. 2 "Writing Analytic Memos" (pp. 41–56)

The single most direct source. Memos are the analysis, distinct from the codes:

> "Codes written in the margins of your hard-copy data or associated with data and
> listed in a CAQDAS file are nothing more than labels until they are analyzed."
> (p. 41)

> "Analytic memos are somewhat comparable to researcher journal entries or blogs –
> a place to 'dump your brain' about the participants, phenomenon, or process under
> investigation… 'Memos are sites of conversation with ourselves about our data'
> (Clarke, 2005, p. 202)." (pp. 41–42)

Memos are **dated, titled, searchable, and themselves codable** — the four
properties that make them an *artifact* rather than a metadata field:

> "Yes, memos are data; and as such they, too, can be coded, categorized, and
> searched with CAQDAS programs. **Dating each memo helps keep track of the
> evolution of your study.**" (p. 42)

And they carry the audit-trail function compost exists to provide — Saldaña's
MEMO mnemonic opens with:

> "**M – Mapping research activities** (documentation of the decision-making
> processes of research design and implementation as an audit trail)" (p. 49)

> "If data are the building blocks of the developing theory, memos are the mortar
> (Stern, 2007)… 'a series of snapshots that chronicle your study experience'
> (Birks & Mills, 2011)." (p. 50)

Saldaña also draws the memo / field-note line that maps directly onto compost's
corpus-vs-interpretation split — memos are the *curated, extracted* interpretive
layer, kept separate from raw data:

> "I recommend extracting these memo-like passages from the corpus and keeping
> them in a separate file devoted exclusively to analytic reflection." (p. 42)

### Braun & Clarke — Reflexive Thematic Analysis (via DeTAILS, arXiv:2510.17575)

In RTA the researcher is the analytic instrument; reflexivity — enacted through
memoing/journaling — is what makes the method rigorous, and it is **irreducibly
the researcher's iterative work**, not something a tool can hand off:

> "In RTA, the researcher plays an active, interpretive role in theme development
> rather than applying a fixed codebook… Reflexivity is central: researchers
> acknowledge their subjectivity and positionality, recognising how analytic
> decisions shape knowledge production." (DeTAILS §2)

This is the load-bearing fit: compost can *surface* patterns and *draft*
candidate memos for endorsement, but the reflexive record is the analyst's — so
memos belong in compost as **researcher-owned artifacts under the endorsement
gate**, never as tool-authored truth.

### Haraway & Latour — why the record must be provenance-bearing

- **Haraway, "Situated Knowledges" (1988):** accountable knowledge requires a
  "critical, reflexive relation" to one's own practice. A memo is the vehicle by
  which the analyst documents how their position shapes the reading — the
  reflexive trail Haraway's epistemology demands.
- **Latour, "Give Me a Laboratory" (1983):** credibility rests on chains of
  *inscriptions* — layered written records of each analytic displacement. Memos
  are precisely the inscription layer for interpretive moves: they record the
  *why* at each step so the trail is auditable. This is the same logic ADR 0002
  invokes (Latour & Woolgar) for category provenance.

### compost's own forward references

- **ADR 0002 §5:** "Categorization is where analytic memoing intensifies, so a
  Category is a natural attachment target for a Memo (see Memo ADR, future)."
- **ADR 0002 §Downstream:** "Memo artifact ADR (Category and Code as memo
  targets) — future."
- **North Star §13:** "Provenance is mandatory; history is a surface… the trust
  surface that makes heavy delegation feel safe." An event says *"code C applied
  to highlight H"*; a memo says *"because I read pattern X against question Y,
  building on Z."* Memos are the analyst's side of the provenance conversation.

## Distinction from neighbors (what a memo is NOT)

§7 (name it once) requires a memo be genuinely distinct from every existing noun,
or it is a synonym bug. It is:

| Neighbor | What it is | How a memo differs |
|---|---|---|
| **`theme`** | A synthesis *finding* with an evidence set (`{code\|category}`) | A memo is the *reasoning/journey* — multi-paragraph, may cover dead ends, may span several themes or none. A theme asserts; a memo deliberates. |
| **glossary `term`** | UI-only, non-persisted vocabulary tagger (`web/lib/glossary.ts`) | A memo is an event-persisted artifact with provenance, versioning, and endorsement. The term has none of these. |
| **code / category `definition`** | The (relatively stable) meaning of a label | A memo is dated and evolving — the running record of *how* the definition was arrived at and is being questioned. A definition is the current answer; a memo is the open conversation. |
| **`highlight`** | An utterance-level evidence span in the corpus (raw datum) | A memo is interpretation *about* highlights — Saldaña's curated layer extracted *from* the corpus, not part of it. |
| **`insight`** | A structured, single-finding derivation | A memo is narrative and may be inconclusive by design. |

Net: no existing noun holds the dated, evolving, anchored, codable record of the
analyst's thinking. The slot is real and empty.

## The data model (locked decisions)

The four load-bearing decisions were made by the maintainer up front:

### Artifact shape

- **Kind:** `memo`. **Stable id:** `M-<slug>` (joins `H-/C-/CB-/CAT-/T-`).
- **Markdown:** `synthesis/memos/M-<slug>.md` (sibling of `synthesis/themes/`).
- **Event:** `artifact_kind: memo`, SHA256-addressed initial state, atomic
  write-then-emit with rollback — identical to every other artifact
  (`cli/src/lib/artifacts.ts` pattern).
- **Frontmatter:** `id`, `type`, `codebook_id?` (frame scope; `null` =
  cross-frame / project-level), `anchors` (heterogeneous, see below),
  `artifact_id`, `provenance: {actor_type, actor_id}`. Body = the memo prose.

### Authorship + endorsement — *decision: researcher-authored; AI may draft, endorse-gated*

Memos follow the same three-actor model and `[draft]` gate as codes and themes.
A researcher-authored memo is trusted on creation; an AI-drafted memo
(`--ai`, born `[draft]`) is **untrusted until a researcher `endorse`s it**, and
the self-endorse guard applies. `reject` archives (never deletes); `blame` prints
the lineage. This is what keeps the feature on the right side of "not the
analyst" (§ audit, check 2): compost may *carry* an AI-proposed interpretation,
but it never *presents* it as trusted without a human in the loop.

### Anchors + codability — *decision: anchors to any artifact, and memos are themselves codable*

- **Anchors (outbound):** a memo cites a heterogeneous set
  `{kind: highlight|code|category|theme|codebook, ref, codebook_id?}` — the same
  token encoding themes already use for evidence (`kind:ref:codebook_id`,
  `cli/src/lib/themes.ts`), reused rather than reinvented. Zero anchors is valid:
  a project-level reflexive memo.
- **Codable (inbound):** because "memos are data" (Saldaña p. 42), a `memo` is
  itself a valid evidence/coding target — a `code`'s or `theme`'s evidence may
  include `kind: memo`. Backward-link queries surface "memos about this code".
- **Invariant — memos don't inflate coverage math:** a memo cited as evidence
  must **not** count toward code/category saturation or κ/α (a memo is not a
  participant utterance). This mirrors how secondary category links are excluded
  from saturation. Enforced in `lib`, once.

### Type — a constrained set, not a free string (§9)

`type ∈ { code | category | theme | reflexive | method | theory | freeform }`,
default `freeform`. This is a deliberate reduction of Saldaña's ~11 reflection
categories to the load-bearing few; it keeps invalid states unrepresentable while
covering code/theme memos, reflexive (positionality) memos, method memos
(decision/audit trail), and theory memos. The exact membership is the one
sub-decision left to confirm at implementation — flagged in the keystone issue.

### Editing = `update`, and the ledger *is* Saldaña's "dated snapshots"

Memos are revisited iteratively (Saldaña). Editing a memo emits an `update` event
(field-level, with before/after) rather than spawning a new file. compost's
append-only ledger then **natively provides** Birks & Mills' "series of snapshots
that chronicle your study experience" — the chronology lives in events, queryable
via `blame`, without a parallel versioning scheme. The markdown is the current
state; the ledger is the evolution.

## Surfaces (§7 — one name everywhere)

One vocabulary across all three adapters; each is a thin parse-call-render layer
over `cli/src/lib`, no domain logic:

- **CLI:** `compost memo new | edit | view | list | cite | endorse | reject`
  (a command group like `codebook` / `category`; `endorse`/`reject` may route to
  the existing generic verbs).
- **MCP:** `compost_create_memo` (aiAuthored → born `[draft]`),
  `compost_list_memos`, `compost_cite_memo`, `compost_edit_memo` — argv wrappers
  over the CLI (house rule: build the verb first, then wrap).
- **Web:** **deferred.** CLAUDE.md's live tension forbids rendering the codebook
  verbs into the web UI "until that surface itself is designed"; the same gate
  applies to memos. Tracked as a `blocked` / `needs-design` issue against
  milestone #4, not built here.

## Kill-filter audit (CLAUDE.md pre-flight)

| # | Check | Verdict |
|---|---|---|
| 1 | Can an agent reach this outcome *without* compost? | **No.** An agent can write prose to a loose `.md`, but only compost gives it the append-only three-actor provenance, the dated event-ledger chronology, content-addressed identity, the `[draft]`→endorse gate, and bidirectional codability (memo-as-evidence resolved through `lib`). That is durable verifiable state + provenance — the irreplaceable layer. **Pass.** |
| 2 | Not the analyst? | **Pass, conditionally** — and the condition is the whole design. A memo *is* interpretation, so compost must only ever **store and version** it, never generate-and-assert it. The endorsement gate enforces exactly that: AI-drafted memos are born `[draft]` and untrusted until a human endorses (decision 2). compost holds the interpretation and records who decided it; it does not decide. The failure mode to never build is auto-endorsed AI memos or an embedded "what does this mean?" loop — explicitly excluded. |
| 3 | Human stays free (CLI, offline)? | **Pass.** Every memo verb is a CLI command a person runs directly, offline, no agent required (`compost memo new/edit/view/list`). The AI-draft path is an accelerant, not life support. |
| 4 | Validated need, or typing for an unvalidated need? | **Grounded, not demonstrated** — see below. The canon (Saldaña, RTA) and ADR 0002's forward-reference establish the *capability* is real and planned; ATLAS.ti shows the codable-memo design is converging in the field. But the need has **not** fired on compost's one real study, and addendum live-tension #4 warns directly against adding apparatus on thin validation. This is a maintainer call, not an automatic pass. |

### The live tension this feature sits inside

Addendum "Live tensions" #4: *"The whole methodology layer is validated against
one dogfood (Edges & Ecotones, one coder). Get a second, independent corpus
before adding more apparatus."* Memos **are** more apparatus. Surfacing this is
mandatory per CLAUDE.md ("when a rule and a request conflict, surface the
conflict"). The honest read: filters 1–3 pass cleanly; filter 4 is the same
"grounded but not demonstrated" verdict that `duplicate | merge` got, against an
addendum caution that has not yet been retired.

## Decision (maintainer, 2026-06-13)

Filter 4 came back **"grounded but not demonstrated,"** and addendum tension #4
is unretired. Presented with the gate, the maintainer (Juan) chose to **proceed
on grounding** — create milestone #9 and the implementation issues now — making
the explicit call that:

1. The methodology grounding (Saldaña's dedicated chapter; RTA's reflexivity
   core) + ADR 0002's standing forward-reference + the ATLAS.ti convergence
   constitute sufficient validation of the **capability**, and
2. The absence of a demonstrating scenario is, as with `duplicate | merge`, an
   artifact of the single-study dogfood workspace rather than evidence the need
   is unreal.

This override is recorded so the reasoning is on the record: the milestone was
**not** opened because the kill filter cleared automatically on real data — it
was opened on a deliberate maintainer judgment that the grounding suffices. The
build stays scoped to the data-model + CLI/MCP core (web deferred), and the first
natural validation is to **write real memos against the Edges & Ecotones seed the
moment the keystone slice lands**, before building the AI-draft skill on top.

## Sequencing → milestone #9 issues

Dependency-ordered slices (each a milestone-#9 issue):

1. **lib core — the `memo` artifact** (`create/get/update/list/reject`, markdown
   + events, type enum, anchor encoding, invariants, tests). *Keystone.*
2. **Endorsement gate** — AI-drafted memos born `[draft]`; `endorse`/`reject`/
   `blame` cover `memo`; lifecycle tests.
3. **Codable memos + bidirectional linkage** — memo-as-evidence; backward-link
   queries; the no-inflate-saturation invariant.
4. **CLI surface** — `compost memo` command group (thin adapter).
5. **MCP tools** — `compost_create_memo` (aiAuthored) + list/cite/edit wrappers.
6. **Integrations** — `status` counts, BM25 `search` indexing, PROV-O `export`,
   `reindex` snapshots.
7. **AI-draft path** — memo-scaffolding skill: drafts a grounded memo `[draft]`,
   never auto-endorses (the decision-2 authorship path).
8. **Docs / CHANGELOG / addendum** — fold `memo` into the addendum nouns+verbs;
   release notes; this doc + ADR 0004 finalized.
9. **Web surface — deferred tracker** (`blocked` / `needs-design`, milestone #4).

## References

- Saldaña, *The Coding Manual for Qualitative Researchers*, 2nd ed., Ch. 2
  "Writing Analytic Memos."
- Braun & Clarke, Reflexive Thematic Analysis (as situated by DeTAILS,
  arXiv:2510.17575).
- Haraway, "Situated Knowledges" (1988); Latour, "Give Me a Laboratory" (1983).
- [ADR 0002 — Category tier](./adr/0002-category-tier.md) (forward-reference).
- [ADR 0004 — Analytic memos](./adr/0004-analytic-memos.md) (the decision record).
- [North Star](./north-star-humans-and-agents.md) §§7–10, 13, 15;
  [addendum](./north-star-addendum.md) (stance; live tension #4).
- [`dogfood-edges-ecotones-duplicate-merge.md`](./dogfood-edges-ecotones-duplicate-merge.md)
  (the "proceed on grounding" precedent this audit mirrors).
