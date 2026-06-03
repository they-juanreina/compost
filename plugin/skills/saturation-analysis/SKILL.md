---
name: saturation-analysis
description: Assess whether a compost seed has reached thematic saturation by measuring per-session theme novelty from the index. Recommends continue / pause / conclude.
---

# saturation-analysis (compost, index-backed)

Refactor of the research-os skill. Reads themes from the seed's index and
computes novelty per session in order.

## Flow

1. For each session (chronological), compute novelty = fraction of its themes
   not seen in any earlier session (`saturationPulse`).
2. Recommend:
   - **continue** — novel themes still appearing
   - **pause** — the latest session added nothing new (review before continuing)
   - **conclude** — N consecutive dry sessions (default 2) → saturation reached
3. Report per-session novelty and the recommendation with a rationale.

## Guardrails

- This is a signal, not a verdict; the researcher decides. The recommendation
  is reproducible from the index (no hidden state).
