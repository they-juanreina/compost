# ADR 0006: Ingest provenance — a transcript is attributed source, not an endorsable artifact

- **Status:** Accepted (decision); **implementation deferred** to #325. Parsing shipped ahead of the event in #323.
- **Date:** 2026-07-04
- **Deciders:** Juan (maintainer)
- **Related:** [ADR 0004 — Analytic memos](./0004-analytic-memos.md) (the endorsable-artifact / three-actor model this ADR draws the line against), #323 (shipped `.vtt`/`.srt` caption import, declared *"Provenance impact: No"*), #325 (implementation follow-up), #322 (tamper-evidence research — an orthogonal axis), `CLAUDE.md` §13 (no silent writes), §15 (local-first).

## Context

A researcher who already has transcripts brings them in via `compost import`
(text shapes, and `.vtt`/`.srt` captions as of #323). Two facts about how those
land today force a decision:

- **`compost import` writes `sessions/<id>/transcript.json` with no event.** It is
  a silent write — which `CLAUDE.md` §13 ("every artifact mutation emits an
  append-only event tagged with its actor; no silent writes") forbids. #323
  extended the same silent path to caption formats.
- **The async queue path emits only a thin `ingest_job`** (`{source_path, kind,
  category}`), which records that a file was *enqueued*, not the provenance of the
  canonical transcript that results.

So the question *"where did this session come from — original file, format, who
landed it, when?"* is **not answerable via `blame`/`status`.** That answer is
exactly the differentiator compost should own for ingestion (an agent can convert
a file; only compost lands it as attributed, local, canonical corpus), and today
it's missing.

Underneath sits an unsettled modelling question: **is a transcript a first-class,
provenance-bearing artifact** — like a code/theme/memo, born `[draft]` and gated
behind `endorse` (ADR 0004) — **or is it ingested *source* data** that carries
provenance but is never endorsed? This ADR settles both.

## Decision

1. **A transcript is ingested *source* data, not an endorsable artifact.** It does
   not pass through the `[draft]`→`endorse` gate and is not graded. It is raw
   material the analyst interprets — not an interpretation compost authors — so
   inflating it into a gated artifact would be miscategorising it.

2. **Every landing emits exactly one append-only ingest-provenance event.** Both
   the sync `import` path and the async queue converge on the shared transcript
   assembler, and the event is written there **once, not per-format**, carrying:

   ```
   { original_name, source_uri?, format, parser, parser_version,
     ingested_at, actor, sha256 }
   ```

   Actor = `researcher` for CLI `import`; `agent` for the queue worker. `sha256`
   lets `status` flag "this file was already ingested" rather than silently
   duplicating.

3. **This closes the §13 silent-write gap and makes `blame <session>` / `status`
   answer provenance** — without making a transcript something that needs
   endorsement.

4. **compost owns format parsing at the `classify`/assembler seam; it does not own
   transport.** Files arrive by any means — a person, an agent, or a canvas node
   calling `compost_ingest`. Drive/SharePoint-style connectors are explicitly out
   of scope, keeping local-first (§15) intact and connector maintenance out of the
   core.

## Consequences

- **Positive:** provenance of ingestion becomes queryable; the silent write is
  removed on every path; local-first is preserved; connector maintenance stays
  external.
- **Deferred / sequencing:** #323 shipped the caption *parsing* ahead of the
  event, accepted so a P0 dogfood fix wasn't blocked on this decision. The event
  itself is tracked in **#325** and must clear the `CLAUDE.md` pre-flight before it
  earns code (it does: it provides durable, verifiable, local provenance no agent
  can supply alone).
- **Orthogonal:** making that provenance *tamper-evident* (hash chain / signatures,
  the #322 research note) is a separate axis — this ADR is about *emitting* the
  event, not hardening it against a motivated forger.
- **Out of scope:** PDF/DOCX ingest re-architecture, word-level timings, and
  transport connectors remain out (see #325).
