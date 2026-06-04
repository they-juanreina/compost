---
name: querying-research-knowledge
description: Answer questions about a compost seed grounded in retrieved evidence with enforced citations — every claim quotes a real utterance verbatim, and "insufficient evidence" beats a guess. Use whenever the user asks what the research shows, what users said, what we know about behavior, why a design decision was made, what pain points emerged, or wants to compare framings across seeds. In a compost project this replaces research-os:querying-research-knowledge because it does RAG over the indexed seed rather than cold-reading sessions.
---

# querying-research-knowledge

RAG-first Q&A over a compost seed. The CLI does retrieval + synthesis +
citation enforcement; this skill is the cover letter that wraps it.

## Single-seed queries (default)

1. Run `compost chat --seed <name> "<question>" --json`. Add
   `--chat-id <id>` to continue a prior thread (each chat persists in the
   seed's `.compost/chats/`).
2. The CLI does hybrid retrieval (BM25 + dense once embeddings are indexed),
   calls the synthesis model with a strict answer schema, and enforces
   citations deterministically: every claim must quote a real utterance
   verbatim. Schema mismatches and quote drift are rejected and re-prompted;
   after 3 failures the CLI returns `{"answer": "insufficient_evidence", ...}`
   and exits with code 3.
3. Present the answer with its `citations[]`. **Never** render a claim without
   the matching citation underneath it. If the result is `insufficient_evidence`,
   say so plainly — fabricating an answer destroys the seed's audit trail.

## Cross-seed comparison

When the question compares seeds ("how did seed A vs seed B frame trust?"),
run `compost chat` per seed and synthesize the cited answers side by side.
Fan-out is over RAG, not over cold-read — each per-seed call is still
citation-enforced. The synthesis you write at the top is *yours*, but every
claim in it still needs to point at a citation from one of the per-seed
answers.

## Why citations are non-negotiable

The validator backs this deterministically: the synthesis model is forced into
a structured-output tool call whose `citations[]` get string-matched against
the retrieved corpus, and unmatched citations get rejected before the answer
ever leaves the CLI. Treating "insufficient evidence" as a failure mode the
user can recover from (collect more data, broaden the seed) is *better* than
treating it as a prompt to guess. Guesses survive into synthesis docs and
poison every downstream artifact.

## Example output (one claim)

```markdown
**Participants distrust automated alerts and default to manual verification.**

- [U-0001 @ S001]: "Cuando entra una alerta, yo no sé si confiar."
- [U-0014 @ S001]: "Prefiero verificar manualmente antes de actuar."
```

For `insufficient_evidence`, render this and stop:

```markdown
> **Insufficient evidence in this seed.** The retrieval surfaced no utterances
> bearing on this question. Consider broadening the seed or running more
> sessions before asking again.
```

## Verifying

Golden cases live at `evals/golden/querying-research-knowledge/` (an
`input.json` with question + retrieved utterances, an `expected.json` with the
answer + citations the grader should see). Run
`compost evals run --skill querying-research-knowledge` after changes.
