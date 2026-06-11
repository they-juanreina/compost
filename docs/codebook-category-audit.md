# Audit: the codebook/category ADRs against the codebase

Status: **complete** · Date: 2026-06-11 · Branch: `docs/codebook-category-adrs`

[ADR 0001 (codebook multiplicity)](./adr/0001-codebook-multiplicity.md) and [ADR 0002 (category tier)](./adr/0002-category-tier.md) were drafted externally, without code access, together with a dogfood plan. This report records the claim-by-claim verification of their premises against the codebase, the impact estimate for implementing them, and the sequencing that follows. It is the evidence base for the amendment sections in both ADRs and for [ADR 0003 (interfaces)](./adr/0003-interfaces-monorepo-plugin-tauri.md).

**Verdict up front:** the ADRs are adopted. Every mechanism they lean on exists and is implemented; two premises needed correction (no codebook artifact exists today; the event vocabulary is six actions, not four — both corrections *help* the ADRs); one proposed change is breaking (theme evidence restructure) and is sequenced behind an additive first slice.

## 1. Claim verification

| # | ADR claim | Verdict | Evidence |
|---|---|---|---|
| 1 | "The current data model reads as one codebook per seed" | **Partially true** | True of the ROADMAP diagram. In code there is **no codebook artifact at all** — `Seeds/<seed>/codebook/` is a directory of per-code `.md` files written by `createCode` (`cli/src/lib/artifacts.ts:158`). ADR 0001 *introduces* the artifact. |
| 2 | "All expressible with existing event actions: create \| update \| link \| unlink" | **True, undersold** | The enum is `create\|update\|endorse\|reject\|link\|unlink` (`schema/events.schema.json:40`; `provenance/src/types.ts:3`). `endorse`/`reject` are the gate the cross-lens theme regime needs — already implemented. |
| 3 | Three-actor provenance model | **True** | `researcher\|agent\|ai` (`provenance/src/types.ts:1`); enforced in the reducer (`provenance/src/reducer.ts:55`). |
| 4 | Endorsement gate (AI draft → researcher endorses) | **True** | `human_approved` on snapshots (`provenance/src/migrations/0002_snapshots.sql`); endorse/reject flow with self-endorse prevention (`cli/src/lib/artifacts.ts:360`). |
| 5 | `compost agreement` ships Cohen's κ + Krippendorff's α | **True** | `cohensKappaBinary` (`cli/src/lib/agreement.ts:61`), `krippendorffAlphaNominal` (`cli/src/lib/agreement.ts:93`), per-code + pooled, Landis–Koch interpretation, `--min-units` insufficiency gate. |
| 6 | `compost recode` ships blind double-coding | **True** | Link events, `artifact_kind='coding'`, payload `{code, highlight, blind: true}` (`cli/src/lib/recode.ts:31`). The `blind: true` payload is the in-repo precedent for ADR 0002's `is_primary` link payload. |
| 7 | `compost saturate` ships | **True, different denominator** | Per-session **theme novelty**: walks `synthesis/themes/` frontmatter → `theme.codes` → `code.evidence` → highlight `session_id` (`cli/src/lib/saturate.ts:29`), delegating to `saturationPulse` in `@they-juanreina/compost-retrieval`. No `--codebook` scoping. ADR 0002's category-coverage denominator is a redefinition, not a flag. |
| 8 | `compost export --format prov` ships | **True** | W3C PROV-O (JSON-LD) with PROV-AGENT vocabulary (`cli/src/exporters/prov.ts`; design in [provenance-deepening-design.md](./provenance-deepening-design.md)). |
| 9 | Cross-session-similarity scanner suggests codes / drafts candidates | **True** | `compost rescan` (`cli/src/commands/rescan.ts`) + `cli/src/loops/synthesis.ts`: clusters un-coded highlights (`suggestCodeClusters`, cosine threshold 0.75), emits `[draft]` code artifacts as agent `similarity-scanner`, ≤20/run. |
| 10 | "Retrieval chunk metadata (`code_ids[]`) becomes codebook-qualified" | **Field exists; pipeline half-wired** | `ChunkMetadata.code_ids[]` exists (`retrieval/src/types.ts:11`) and is written to LanceDB (`cli/src/loops/embed_worker.ts:142`), but it is populated only from transcript-time input (`retrieval/src/chunker.ts:84`) — **codes created later never reach chunk metadata**. Codebook-qualification inherits this backfill gap. |
| 11 | Theme evidence: "existing code → theme evidence remains valid / additive" | **False for themes** | Theme payload is `{id, kind:'theme', name, summary, codes[]}` (`cli/src/lib/artifacts.ts:203`) — no `evidence` field. The heterogeneous `evidence[]` is a restructure; `saturate` consumes `theme.codes` and must be rewired. The one breaking change in the ADR set. |
| 12 | Category suggestion via centroid of evidence embeddings | **Primitive exists; application missing** | The centroid math is already in `retrieval/src/clustering.ts`: `meanVector` (line 94) and `clusterByEmbedding` (line 23), which assigns items by cosine similarity **to the cluster centroid** (pairwise cosine is only the cohesion metric). What's missing is the level-up application: embedding a *code* as the centroid of its evidence highlights and clustering those — new plumbing, not new math. |
| 13 | In-vivo name validation "reusing the citation validator" | **Validator exists; not wired** | `validateAnswer` is used for chat-answer citation enforcement (`cli/src/lib/chat.ts:60`); nothing validates code names against evidence. Feasible reuse, real work. |
| 14 | Dogfood plan commands | **Several don't exist yet** | `compost init --question`: no such flag (`cli/src/commands/init.ts` has `--force/--from-legacy/--from-sample`). `compost codebook …`: no verb. `compost code … --codebook`: `compost code` is the cluster-*suggester*; manual coding is `compost create code`. `agreement --codebook`: no scoping. PDF→`_inbox`→`watch --once`: real (`cli/src/lib/dispatch.ts:24` routes PDFs to legacy-ingest; `cli/src/commands/watch.ts:35` drains once). |

## 2. Corpus correction to the dogfood plan

The external dogfood plan proposed ingesting the twelve grounding-literature texts as the test seed, predicting "theory books strain the model" seams (no speakers, secondary sources). **Superseded by maintainer decision:** the twelve PDFs are design-rationale literature, not test data. The dogfood corpus is the **"Edges and Ecotones: Donna Haraway's Worlds at UCSC" oral history** (Haraway interviewed by Irene Reti, 2007, UCSC Regional History Project — [escholarship.org/uc/item/9h09r84h](https://escholarship.org/uc/item/9h09r84h)): public, citable, primary interview data — and the interviewee is a grounding-corpus author, so the reflexive loop survives. The study is designed to be **replicable by anyone** (wiki walkthrough; doubles as the cross-user/cross-machine/cross-team test protocol). The predicted-seams section of the original plan is moot; the replication study records *interview-shaped* seams instead (two-speaker transcript PDFs without diarization, single-interview saturation, paragraph-utterance addressing).

## 3. Impact estimate

| Change | Size | Touches |
|---|---|---|
| (a) New artifact kinds `codebook`, `category` | **Low** | `artifact_kind` is free-form by design (`schema/events.schema.json`); create functions follow `createCode`/`createTheme` patterns in `cli/src/lib/artifacts.ts`; `blame`/`endorse`/reads are already kind-generic. |
| (b) `codebook_id` on code creation | **Low** | `CreateCodeInput` + initialState + frontmatter; default `CB-primary`; readers verified tolerant (see §4). |
| (c) `codebook_id` through retrieval | **Medium** | `retrieval/src/types.ts` ChunkMetadata, `chunker.ts`, `embed_worker.ts`, query filters — and it inherits the `code_ids[]` backfill gap (claim 10), which must be fixed for codebook-filtered retrieval to mean anything. |
| (d) Nullable `theme.codebook_id` + ≥2-codebook validation | **Low–medium** | `CreateThemeInput` + a validation hook at create. |
| (e) Link payload `is_primary` | **Low** | Extends the `blind: true` precedent. |
| (f) Theme `codes[]` → `evidence[]` + `saturate` rewiring | **Medium, breaking** | `artifacts.ts`, `saturate.ts`, future `synthesize`; lazy-mapping migration window. |
| (g) `--codebook` scoping on agreement/recode/saturate | **Medium** | `coding` link payloads gain codebook dimension; κ/α grouping keyed by codebook; until then agreement **silently pools lenses** on multi-codebook seeds. |
| (h) Migration of existing codes to `CB-primary` | **Medium** | Explicit dry-run/apply verb + lazy-on-read defaults; append-only preserved (update events, never edits). |
| (i) Category suggestion (code-level clustering) | **Low–medium** | Reuses `meanVector`/`clusterByEmbedding` (`retrieval/src/clustering.ts`); new plumbing builds code-centroid `EmbeddedItem`s from evidence embeddings. |
| (j) Category verb surface + review states (orphan/multi-home) | **Medium** | CLI verbs + web UI surfaces (v0.2). |

## 4. Reader-tolerance check (what slice 1 verified before landing)

- `agreement.ts` / `recode.ts` consume code **names** on `coding` link events — indifferent to `codebook_id` on code artifacts.
- `saturate.ts` parses code frontmatter for `id` + `evidence` and ignores unknown scalars — a `codebook_id` scalar is inert.
- `status.ts` counts every `.md` under `codebook/` as a code — which is **why codebook artifacts live in a sibling `codebooks/` directory**, not inside `codebook/`.
- The similarity scanner's drafts gain `codebook_id: 'CB-primary'` so event data stays uniform.

## 5. Sequencing

1. **Slice 1 (additive)** — codebook artifact + `compost codebook new|list|migrate` + `codebook_id` on codes + `init` primary codebook + `--question`. *(`feat/codebook-slice-1`)*
2. **Replication study** — the Edges-and-Ecotones wiki walkthrough run end-to-end against slice 1; findings doc records seams.
3. **Scoping slice** — `--codebook` on agreement/recode/saturate; `coding` payloads gain codebook dimension.
4. **Category slice** — category artifact + link `is_primary` + theme `evidence[]` restructure + `saturate` rewiring (the breaking change, isolated).
5. **Retrieval slice** — `code_ids[]` backfill loop + codebook-qualified chunk metadata + filters; centroid math; AI-proposed categories.
6. **Follow-ups** — MCP codebook tools (verb-first rule), in-vivo enforcement, `codebook merge|fork|import`, Memo ADR, Tauri packaging spike ([ADR 0003](./adr/0003-interfaces-monorepo-plugin-tauri.md)).

## 6. Method

Three parallel read-only exploration agents (data model/events; verb surface/analysis machinery; ecosystem/architecture) over the repo at `v0.1.3`+, followed by manual spot-checks of the load-bearing claims (theme payload shape, stub commands, engine export). Claim verdicts above cite the spot-checked locations; line numbers are accurate as of this branch and will drift — symbol names are the stable anchor.
