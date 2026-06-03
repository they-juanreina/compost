---
name: saturation-analysis
description: Assess whether a compost seed has reached thematic saturation by computing per-session theme novelty from the indexed corpus, then recommending continue / pause / conclude. Use whenever the user asks about saturation, diminishing returns, whether more sessions are needed, when to stop collecting data, has enough sessions been run, or wants a saturation-curve interpretation. In a compost project this replaces research-os:saturation-analysis because it reads themes from the index instead of session notes.
---

# saturation-analysis

Compute thematic-saturation novelty from the seed's coded corpus and report a
continue / pause / conclude recommendation. The math lives in
`compost saturate`; this skill is how you frame and present its output.

## Flow

1. Run `compost saturate --seed <name> --json`. The CLI walks each session
   chronologically (by id), joins theme → code → highlight → session to figure
   out which themes that session contributed to, then for each session
   computes novelty = fraction of its themes not seen in any earlier session.
2. Render the per-session novelty curve and the recommendation. The CLI emits:
   - `per_session[]` — one entry per session with `new_themes[]` and `novelty`
   - `recommendation` — `continue` | `pause` | `conclude`
   - `rationale` — one-line human-readable reason
3. If the user wants a different sensitivity, pass `--dry-streak <n>`
   (default 2). One dry session triggers `pause`; `n` consecutive dry sessions
   triggers `conclude`.

## Why this is a signal, not a verdict

A flat tail in the novelty curve is evidence that you've heard most of what
the current sample population has to say — it is *not* evidence that no new
themes exist in the wider world. The recommendation is reproducible from the
index (no hidden state, no model call), but the call to stop recruiting is
the researcher's; saturation by theme novelty under-counts variance you'd
only see with a different population. Present the curve, surface the
recommendation, let the researcher decide.

## Example output

```markdown
**Saturation: pause** (after 4 sessions)

| session | new themes                              | novelty |
| ------- | --------------------------------------- | ------- |
| S001    | T-control-earns-trust, T-alert-fatigue  | 1.00    |
| S002    | T-manual-override                       | 0.50    |
| S003    | T-asymmetric-blame                      | 0.33    |
| S004    | —                                       | 0.00    |

> The last session added no new themes. Pause and review before running S005.
```

## Verifying

Golden cases live at `evals/golden/saturation-analysis/` (each pairs an
`input.json` of sessions + themes with an `expected.json` carrying the curve
and recommendation the math should produce). Run
`compost evals run --skill saturation-analysis` after touching the join logic
in `cli/src/lib/saturate.ts` or the math in `retrieval/src/clustering.ts`.
