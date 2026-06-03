---
name: querying-research-knowledge
description: Answer questions about a compost seed, grounded in retrieved evidence with enforced citations. RAG-first for single-seed queries; fan-out for cross-seed comparison.
---

# querying-research-knowledge (compost, RAG-first)

Refactor of the research-os skill. Instead of cold-reading every session, this
version retrieves first and cites always.

## Single-seed queries (default)

1. Run `compost chat --seed <name> "<question>" --json`.
2. The CLI does hybrid retrieval (BM25 + dense once embeddings are indexed),
   calls the synthesis model with the answer schema, and **enforces citations**:
   every claim must quote a real utterance verbatim. Mismatches are rejected and
   re-prompted; after 3 failures it returns `insufficient_evidence` (exit 3).
3. Present the answer with its `citations[]` (utterance_id + quote). Never
   present a claim without a citation. If the result is `insufficient_evidence`,
   say so — do not fabricate.

## Cross-seed comparison (fan-out retained)

When the question compares seeds ("how did seed X vs seed Y frame trust?"),
run `compost chat` per seed and synthesize the cited answers side by side.
Each per-seed agent does RAG over *its* seed — fan-out over RAG, not cold-read.

## Guardrails

- Citations are non-negotiable; the validator backs this deterministically.
- "Insufficient evidence" is an acceptable, preferred answer over a guess.
