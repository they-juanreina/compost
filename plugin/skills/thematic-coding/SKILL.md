---
name: thematic-coding
description: Suggest codes for a compost seed by clustering un-coded highlights in embedding space, with per-code evidence anchors. Embeddings-aware refactor.
---

# thematic-coding (compost, embeddings-aware)

Refactor of the research-os skill. Instead of reading every highlight cold,
this version clusters highlights by embedding similarity and proposes a code
per cohesive cluster.

## Flow

1. Ensure highlights are embedded (`compost reindex --vectors`).
2. The cross-session-similarity scanner (`compost rescan`) clusters un-coded
   highlights via `suggestCodeClusters` (cosine single-link, cohesion-scored)
   and drafts a candidate code per cluster of >= 2 members.
3. Each candidate code is an **AI-suggested** event (actor_type=ai) carrying
   model + prompt_hash, surfaced as `[draft]` until a researcher endorses.
4. Every code anchors to its evidence highlights; never propose a code without
   >= 2 supporting highlights.

## Guardrails

- Suggestions stay un-endorsed until a researcher accepts them.
- The eval-grader scores each suggestion on novelty (is it a near-duplicate of
  an existing code?) and faithfulness before it surfaces above the floor.
