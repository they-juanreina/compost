---
name: journey-mapping
description: Draft a stage-by-stage journey map for a compost seed from its coded highlights and themes, with touchpoints, emotions, and pain points anchored to evidence.
---

# journey-mapping (compost)

Compost wrapper for the research-os journey-mapping skill, drafting from the
seed's coded corpus rather than raw notes.

## Flow

1. Gather the seed's themes and the highlights coded under each
   (`compost status`, codebook, synthesis/themes).
2. Order themes into journey stages (chronological or funnel, as the research
   question dictates).
3. For each stage, draft: touchpoints, the participant's emotion, pain points,
   and opportunities — every entry **anchored to a highlight** (utterance_id +
   quote). No stage entry without evidence.
4. Write the draft to `synthesis/journey-maps/<name>.md` as an AI-authored
   `[draft]`; a researcher endorses or edits before it is final.

## Guardrails

- Stages and emotions are interpretations — mark them as AI-drafted and keep
  the evidence anchors visible so a researcher can audit each claim.
- Prefer "insufficient evidence for this stage" over inventing a touchpoint.
