---
name: thematic-coding
description: Suggest codes for a compost seed by clustering un-coded highlights in embedding space, then emit them as AI-drafted code suggestions a researcher endorses. Use whenever the user wants to do thematic coding, affinity mapping, open coding, code the data, cluster observations, extract themes, or analyze highlights from a compost seed. In a compost project this replaces research-os:thematic-coding because it clusters by embedding similarity rather than cold-reading every highlight.
---

# thematic-coding

Suggest codes by clustering un-coded highlights and emit them as AI
`[draft]` events a researcher endorses. Two-step: preview, then apply.

## Flow

1. Make sure highlights are embedded. Embeddings are written as
   `Seeds/<name>/highlights/<id>.json` sidecars (each `{id, vector}`) by the
   embed-worker during ingest/watch. If the sidecar count is zero, the
   highlights haven't been embedded yet — run `compost watch --once` (or
   `compost reindex --vectors`, which re-runs the embed worker) to embed them,
   then retry. With still no sidecars (e.g. no embeddings provider), surface
   that and stop — there is nothing to cluster.
2. **Preview**: `compost code --seed <name> --json` (or `compost rescan` — same
   underlying logic) clusters via cosine single-link with a cohesion score and
   reports what it *would* suggest. Inspect the preview with the user before
   committing.
3. **Apply**: `compost code --seed <name> --apply --json` runs the same
   clustering and emits each suggestion as an AI-drafted event into the seed's
   event log — `actor_type: ai` carrying model + prompt_hash, surfaced in
   downstream tools with a `[draft]` prefix until a researcher endorses.
4. Require ≥2 supporting highlights per cluster (the default `minSize`). A
   singleton "cluster" is just a highlight; don't promote it to a code.

## Why this shape

Cold-reading every highlight to find themes works at session-1 and falls apart
at session-10. Clustering in embedding space surfaces structure the eye misses
and is reproducible — the same seed produces the same suggestions, so the
researcher's role shifts from "find the patterns" to "judge the patterns." The
`[draft]` gate is what makes that safe: a suggestion isn't a code until a
human says it is, so the cost of a bad suggestion is one rejection, not a
poisoned codebook.

## The `[draft]` / `actor_type: ai` convention

Compost records every artifact's provenance in the event log. AI-authored
events carry `actor_type: ai`, the model id, and a `prompt_hash` so the
suggestion is reproducible. Tools and skills recognise an un-endorsed draft by
this provenance and prefix the title with `[draft]`. Promoting a draft means a
researcher writes a new event with `actor_type: researcher` referencing the
same artifact — the AI event stays in history.

## Example output (one suggested code)

```json
{
  "status": "ok",
  "command": "code",
  "applied": true,
  "suggested": 1,
  "suggestions": [
    {
      "code_id": "C-primary/distrust-of-automation",
      "cohesion": 0.87,
      "members": ["H-001", "H-014", "H-022"],
      "draft_name": "distrust-of-automation",
      "provenance": { "actor_type": "ai", "model": "claude-opus-4-8", "prompt_hash": "…" }
    }
  ]
}
```

Render to the user as: *"3 highlights cluster at cohesion 0.87 — drafted as
`[draft] distrust-of-automation` (H-001, H-014, H-022). Endorse or reject?"*

## Verifying

Golden cases live at `evals/golden/thematic-coding/` (each pairs embedded
highlight fixtures with the cluster shape the grader should see). Run
`compost evals run --skill thematic-coding` after touching the clustering
threshold or the suggestion-emission path.
