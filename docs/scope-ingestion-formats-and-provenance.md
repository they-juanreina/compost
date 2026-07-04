# Scope note — multi-format transcript ingestion & ingest provenance

**Status:** scope-first draft for review · **Stage:** pre-build (no code yet) · **Companion to:** the atomic-surface roadmap (this feeds the ingest "front door" that every surface reads from).

**Decided going in (from discussion):** compost owns *format parsing → canonical
transcript + provenance*. It does **not** own transport connectors (Google Drive,
SharePoint, etc.). Files arrive by any means — a person on the CLI, an agent, or a
Langflow/agent canvas node calling `compost_ingest`. compost's job starts the moment
a file is in hand: canonicalize it and attribute it. This keeps local-first (§15)
intact and keeps connector maintenance out of the core.

---

## 1. Goal & the one invariant

> **Many shapes in → one canonical `Transcript` out, and every landing is attributed.**

New formats are *additive at the parse seam*. They never introduce a second canonical
schema, and they never fabricate fields the source doesn't carry (a missing speaker or
missing word-timing stays absent, not guessed).

## 2. Canonical target (already exists — `cli/src/lib/transcript.ts`)

Every parser must emit a `Transcript`:

```
Transcript {
  schema_version, session_id, source, language, duration_ms, modality[],
  speakers:   [{ id, name?, type }]
  utterances: [{ id, speaker_id, turn, start_ms, end_ms, text, words?, prosody?, annotation? }]
  silences?, cues?, frames?
}
```

Caption formats populate `speakers` + `utterances` (cue-level). `words?`, `prosody?`,
`silences?`, `cues?`, `frames?` stay absent for a caption import — they belong to the
ASR path.

## 3. What exists today (grounding, not assumptions)

| Path | Trigger | Emits an event? | Provenance recorded |
|---|---|---|---|
| **Async `ingest`** (queue) | folder/file walk → `classify()` → worker | ✅ `ingest_job` (actor = `ingest` agent) | thin: `{source_path, kind, category}` |
| **Sync `compost import`** | text transcript (`.txt`) | ❌ **none — silent write** | none |

- `classify()` (`cli/src/lib/dispatch.ts`) already recognizes audio, video, `.pdf`,
  `.docx`, `.pptx`, `.csv`/`.tsv`/`.xlsx`, `.md`/`.txt`.
- **Gap A — the real one:** `.vtt` and `.srt` are unsupported. These are the dominant
  caption exports (Zoom, Teams, Google Meet, YouTube, Otter) and map cleanly to
  utterance-level `{speaker?, start_ms, end_ms, text}`.
- **Gap B — provenance:** the sync path is a silent write; the async path records only a
  thin `ingest_job`. Neither makes "where did this session come from?" answerable via
  `blame`. This is the differentiator compost is supposed to own, and today it's missing.

## 4. Decisions to make before code (this is the scope work)

**D1 — Ingest provenance is an event, always. `[recommended]`**
Every canonical transcript landing (sync *or* async) emits one append-only provenance
event. Closes the silent-write violation (§13), makes ingestion compost's *attributed*
act rather than commodity file-conversion, and gives `blame <session>` / `status` a real
source answer. Proposed provenance record (richer than today's single `source: <path>`
string):

```
{ original_name, source_uri?, format, parser, parser_version, ingested_at, actor, sha256 }
```

**D2 — Route caption formats synchronously. `[recommended]`**
`.vtt`/`.srt` → `Transcript` is deterministic and fast (no ASR). Parse it inline by
extending the `import` path with extension dispatch (`parseText` / `parseVtt` / `parseSrt`),
rather than sending it through the transcribe queue. Keep the queue for work that needs a
worker.

**D3 — Speaker-extraction dialects.** One reused helper, per-format rules:
Zoom VTT `Name: text` · WebVTT/Teams `<v Name>` voice tags · SRT usually speaker-less
(optional inline). Absent speaker → a single synthetic speaker, not a fake name. (§7:
name it once — one derivation function, not per-parser copies.)

**D4 — Turn / merge policy. `[recommended: lossless]`**
One utterance per cue; `turn` increments on speaker change. Downstream can merge
consecutive same-speaker cues; the store shouldn't destroy the cue boundaries the source
gave us.

**D5 — Word-level timings. `[recommended: defer]`**
WebVTT karaoke tags (`<00:00:01.000>`) could populate `words?`. Ties to the roadmap's
open decision #1 (word- vs utterance-level sync). Defer: parse cue-level now, leave
`words?` absent, revisit only when a real corpus actually carries them.

**D6 — Idempotency / re-import. `[recommended: keep refuse + checksum]`**
`import` already refuses when a `transcript.json` exists (§9 transactional). Keep that;
the `sha256` in the provenance record lets `status` flag "this file was already ingested"
instead of silently duplicating.

## 5. Out of scope (explicit — so it isn't silently in scope later)

- **Transport connectors** (Drive/SharePoint/…): decided out. The file arrives; we parse it.
- **PDF/DOCX re-architecture:** they route to `legacy-ingest` today — leave as-is. If
  extraction quality becomes a real need, evaluate **Docling** as a swap-in *behind the
  dispatch seam* — a library choice, not an OpenRAG adoption.
- **Word-level playback sync** (schema-gated; roadmap S0).
- **The evidence-graph view** — separate workstream.

## 6. Done criteria / dogfood

- Drop a real Zoom `.vtt` and a real `.srt`; `compost import <file>` yields a canonical
  `transcript.json` that opens in the reader with speakers and timestamps.
- `compost blame <session>` / `status` shows a **provenance event**: source name, format,
  parser, `ingested_at`, actor.
- The existing `.txt` `import` path now **also** emits the provenance event — the silent
  write is gone.
- Fixtures under `bocashi-dogfood-study/` for a valid VTT, a valid SRT, and a malformed
  one (mirrors the existing `edge-fixtures/` pattern).

## 7. The one call that's yours, not mine

**D1's deeper question: is a transcript a first-class, provenance-bearing artifact, or
ingested *source* data carrying a lightweight ingest event?** This shapes the data model —
whether `blame <session>` is a first-class query, whether `reindex` ever touches
transcripts, whether a transcript can itself be endorsed/rejected.

My lean: **provenance event on every landing; the transcript stays derived source, not an
endorsable artifact.** That gives you the "where did this come from" answer and kills the
silent write, without inflating the transcript into something that needs the endorsement
gate. But it's a north-star decision — flagging it rather than deciding it for you.
