---
name: journey-mapping
description: Draft a stage-by-stage journey map for a compost seed — touchpoints, emotions, pain points, opportunities — with every claim anchored to a coded highlight (utterance_id + verbatim quote). Use whenever the user wants a journey map, experience map, user journey, customer journey, touchpoint map, or service blueprint built from a compost seed's themes and highlights. In a compost project this replaces research-os:journey-mapping because it reads from the seed's coded corpus rather than raw notes.
---

# journey-mapping

Draft a journey map from a compost seed's coded corpus. The map is AI-drafted
and marked `[draft]` until a researcher endorses it.

## Flow

1. Run `compost status --seed <name> --json` to see what's been coded and which
   themes exist. If the seed has no themes yet, stop and suggest
   `/thematic-coding` first — a journey map without themes is pure speculation.
2. Read `Seeds/<name>/synthesis/themes/*.md`. A theme's frontmatter carries an
   `evidence:` list of `kind:ref:codebook_id` tokens — `code:C-<cb>/<slug>:CB-<cb>`
   or `category:CAT-<slug>:CB-<cb>` (ADR 0002 §1, #266); older code-only themes
   may still carry a flat `codes:` list instead. For each **code** ref, open its
   file at `codebook/<codebook>/<slug>.md` (codes are namespaced by frame, #269 —
   an un-migrated seed may still have a flat `codebook/<slug>.md`) and read its
   `evidence:` (highlight ids). For each **category** ref, open
   `categories/<slug>.md` and follow its linked codes. Then open the highlight
   files for the quote + `utterance_id` + `session_id`. This chain is what lets
   every stage cite real evidence — and note which lens (codebook) a stage draws
   on when a seed holds more than one.
3. Order themes into journey stages (chronological or funnel — pick by the
   research question and explain the choice in the draft).
4. Copy `templates/journey-map.md` (sibling of this SKILL.md) to
   `Seeds/<name>/synthesis/journey-maps/<short-name>.md` and fill the
   placeholders. Every `touchpoint`, `emotion`, `pain`, and `opportunity` row
   carries an evidence anchor of the form `[H-XXX @ U-YYYY: "verbatim quote"]`.
5. Leave the `[draft]` marker and `provenance: { actor_type: ai, ... }`
   frontmatter intact — they gate the researcher-endorsement step downstream.

## Why the anchors matter

Stages and emotions are interpretation; quotes are evidence. The anchor lets a
researcher (or an auditor) trace every claim back to the moment in the session
where it came from. "I think they felt frustrated" is an opinion; "they said
'esto no sirve'" is data. Prefer "insufficient evidence for this stage" over
inventing a touchpoint — empty stages are honest, fabricated ones poison the
synthesis.

## The `[draft]` convention

Compost treats AI-authored synthesis as provisional until a human says
otherwise. The `[draft]` title prefix and `actor_type: ai` frontmatter are how
downstream tools (validate, export, eval-grader) recognise un-endorsed work.
Don't strip them; a researcher promotes the draft by replacing the frontmatter
with their own `actor_type: researcher` block.

## Example output (one stage)

```markdown
## Stage 2 — First alert arrives

**Touchpoints:** automated alert banner, mobile push
**Emotion:** wary, deferring action
**Pains:**
- Cannot tell if the alert is real before acting
  — [H-001 @ U-0002: "no sé si confiar"]
- Defaults to manual verification even when the alert is correct
  — [H-014 @ U-0031: "prefiero verificar a mano antes de actuar"]
**Opportunities:**
- Surface a confidence signal alongside the alert
  — derived from theme T-control-earns-trust
```

## Verifying

Golden cases live at `evals/golden/journey-mapping/` (each is an `input.json`
with themes + highlights and an `expected.json` with the stages the draft
should produce). Run `compost evals run --skill journey-mapping` after a
change to keep the skill honest.
