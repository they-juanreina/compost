---
name: intercoder-agreement
description: Measure intercoder reliability on a compost seed — Cohen's κ and Krippendorff's α between a blind researcher's codings and the machine's, within one codebook. Use whenever the user asks about intercoder agreement, reliability, kappa, alpha, whether two coders agree, blind/independent coding, or how trustworthy the coding is. The blind-coding step (`recode`) is the researcher's to run, not an agent's; this skill explains the workflow and runs the read-only `agreement` report.
---

# intercoder-agreement

Reliability = do two coders, coding independently, land on the same codes? compost
computes **Cohen's κ** and **Krippendorff's α** over the units that *both* a blind
researcher and the machine coded — **within one codebook** (ADR 0001: κ is
undefined across frames, because two lenses have different code sets). Two verbs:
`recode` (the human's blind pass) and `agreement` (the read-only report).

## The hand-off rule (important)

`compost recode` is **not an agent tool** — it records a *researcher's* blind
codings, and the whole point is that the human codes **without seeing the machine
codes**. So:

- **Never run `recode` for the user.** Hand off the command and let them code
  blind. If you (the agent) produced the machine codes, you are exactly the
  party `recode` must be blind to.
- You **may** run the read-only `compost agreement` report and interpret it.

This mirrors the rest of compost's trust model: the agent does the computation
and retrieval; the human makes the calls that need to be theirs.

## Workflow

1. **Human codes blind** (hand off): the researcher records their independent
   codings, e.g.
   `compost recode --seed <name> --coder <id> --codebook <ref> --assignments <path>`
   where `<path>` is a JSON map of highlight id → array of code names. They do
   this *before* looking at the machine's codes for the same highlights.
2. **Run the report** (you may run this):
   `compost agreement --seed <name> --codebook <ref> --json`. It reports, over the
   doubly-coded units in that frame:
   - `pooled_kappa` (Cohen's κ) and `krippendorff_alpha`
   - `per_code` breakdown and `doubly_coded_units`
   - `status`: `insufficient` when there are fewer than `--min-units` (default 10)
     doubly-coded units — κ on a handful of items is noise, so it reports
     `insufficient` and an `interpretation` of `undefined` rather than a number.
3. Present κ/α with the doubly-coded count and a plain-language reading; if
   `insufficient`, say so and tell them how many more doubly-coded units are
   needed — don't report a κ that doesn't exist.

## Within one frame only

Always pass (or confirm) `--codebook`. Agreement pools codings *within* the named
frame; running it across lenses would compare different code sets and produce a
meaningless number. To compare two coders, both code the **same** highlights
**under the same codebook** — that's what makes their codings comparable. (A
*duplicated* lens, by contrast, is for an independent re-grounding, not for κ —
see `/codebook-lenses`.)

## Example output

```markdown
**Intercoder agreement (CB-epistemology): insufficient**

Only 4 doubly-coded units; κ needs ≥ 10 to be meaningful (`--min-units`).
Have the researcher code more highlights blind with `compost recode`, then re-run.
```

When there's enough signal:

```markdown
**Intercoder agreement (CB-epistemology): κ = 0.71, α = 0.69** (over 23 units)

Substantial agreement. Lowest-agreeing code: `C-epistemology/positioned-objectivity`
(κ 0.42) — worth a reconciliation pass on its definition.
```

## Verifying

`compost agreement` on a seed below the threshold returns `insufficient` (a quick
sanity check that the gate works); the κ/α math and the gate are covered by
`cli/src/lib/agreement.test.ts`. `recode` writes researcher-authored coding
events — confirm with `compost blame` that they carry `actor_type: researcher`.
