---
name: pattern-coding
description: Group a compost seed's first-cycle codes into second-cycle categories — the pattern-coding tier that sits between codes and themes (ADR 0002). Create categories, link codes (with one primary home per code plus axial links), or cluster codes by the centroid of their evidence to draft AI-suggested categories a researcher endorses. Use whenever the user wants to do second-cycle coding, pattern coding, axial coding, group or consolidate codes, build categories, or organize a codebook after first-cycle coding. This is the second-cycle companion to /thematic-coding (which does first-cycle code suggestion).
---

# pattern-coding

Once a frame has first-cycle codes (see `/thematic-coding`), the next move is to
group them into **categories** — the second-cycle / pattern-coding tier (ADR
0002) between Code and Theme. A category is **codebook-internal**: it groups
codes within *one* frame. The verbs live in `compost category`.

## Verbs

- `compost category new <name> --definition <text> [--codebook <ref>]` — create a
  category in a frame (default `primary`).
- `compost category link <code> <category> [--primary | --no-primary]` — link a
  code to a category. The **first** link is the code's **primary home** (the one
  that drives coverage); additional links are *axial* (a code can sit in more
  than one category). Exactly one `is_primary` per code — `--no-primary` is only
  allowed once another primary exists to carry the code.
- `compost category unlink <code> <category>` — archive a link (append-only;
  never deleted).
- `compost category suggest [--threshold <n>]` — cluster codes by the centroid of
  their evidence embeddings, **within each codebook**, and draft AI `[draft]`
  categories. Requires embedded highlights (`compost watch --once` first). Drafts
  await researcher endorsement.
- `compost category list` — categories and their code membership.

## Flow

1. `compost category list --seed <name> --json` to see what exists.
2. Create or suggest:
   - **Manual:** `compost category new "<name>" --definition "<what it groups>"`
     then `compost category link <code> <category>` for each member. The
     researcher decides the grouping — creating a category is *their* act, not an
     AI draft.
   - **AI-assisted:** `compost category suggest --json` previews centroid
     clusters; each lands as a `[draft]` category the researcher endorses. Same
     `[draft]` gate as `/thematic-coding`: a suggestion isn't a category until a
     human says so.
3. Keep categories **within one frame** — `link` refuses to attach a code whose
   codebook differs from the category's. A pattern that spans lenses is a
   *cross-lens theme*, not a category (use the theme tier for that).

## The primary / axial distinction

Coverage and saturation count a code under its **primary** category only — so the
primary home is the analytic claim "this is what this code is mainly about."
Axial links (additional categories) record the secondary connections without
double-counting. When the user links a code that already has a primary home, the
new link is axial unless they pass `--primary` (which demotes the old primary,
logged in the event log).

## Why a tier between code and theme

First-cycle codes are close to the data; themes are the high-level findings.
Pattern-coding categories are the *organizing* middle — they let the researcher
consolidate "what recurs" before claiming "what it means." Keeping them
codebook-internal preserves the lens separation (ADR 0001): a category is a
reading *within* a standpoint, never a silent merge across standpoints. And
`suggest` is a capability (clustering), not an interpretation — it proposes
groupings as `[draft]`s, leaving the analytic call to the human.

## Verifying

`compost category list` confirms membership and which links are primary. The
invariants (one primary per code, one-frame-per-category, `[draft]` on suggest)
are enforced in `cli/src/lib/categories.ts` and covered by `categories.test.ts`;
the centroid clustering shares the math validated for `/thematic-coding`.
