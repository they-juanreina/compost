# ADR 0005: Reference key & rename model — slugs are cosmetic, `artifact_id` is the foreign key

- **Status:** Accepted (decision); **implementation deferred** until a general rename verb is actually needed.
- **Date:** 2026-06-14
- **Deciders:** Juan (maintainer)
- **Related:** [ADR 0001 — Codebook multiplicity](./0001-codebook-multiplicity.md) (qualified code ids),
  ADR 0004 — Analytic memos (mechanical `M-NNN` id; lands with the memos work),
  the merge reference-guard in `cli/src/lib/codebooks.ts`, addendum live-tension #4.

## Context

Human ids are derived from names by `slug()` and then do **three** jobs at once:

1. **identity** of the artifact (`C-<cb>/<slug>`, `T-<slug>`, `CAT-<slug>`, `CB-<slug>`),
2. **foreign key** in references (theme `evidence`, category `link`s, memo `anchor`s),
3. **filename** on disk (`codebook/<cb>/<slug>.md`, …).

When a name changes, all three want to change together — and keeping them
consistent across every referrer is the "slug fragility" this ADR addresses. Two
facts bound the problem today:

- **There is no general rename verb.** The only id-mutating ops are the
  bare→qualified migration and `codebook merge`, both of which protect integrity
  by **refusing when referrers exist** (`codebooks.ts` reference guard). So the
  dangling-reference fragility is **latent, not live**.
- **The one *active* bug is `slug()` itself** — it was ASCII-only
  (`[^a-z0-9]`), so accented/non-Latin names degraded (`"niñez"` → `ni-ez`).
  Fixed independently in this change set (NFKD diacritic folding); it does **not**
  require this ADR.

compost already computes the stable surrogate it needs: **`artifact_id` — the
SHA-256 of an artifact's initial state — is immutable and content-addressed.**
The fragility exists only because references key on the mutable *slug* instead of
the immutable *SHA*. Memos (ADR 0004) already decoupled identity from the mutable
title by taking a mechanical `M-NNN` id — the same "stable identity, mutable
label" principle, applied there because a memo's title is metadata, not identity.

## Decision

**When a general rename capability is introduced, references will key on the
immutable `artifact_id`, not the human slug-id. The slug stays the display id +
filename — cosmetic and freely re-derivable.**

Concretely, at that point:

1. **Rename = `update{field: name}` event.** `artifact_id` is untouched, so **no
   reference dangles** and nothing must be rewritten or refused. The slug (and
   filename, via re-render) follow from the new name.
2. **References store `artifact_id`** (with an optional human-readable display
   hint), resolved to the current name through the one existing choke point
   (`resolveCodeRef` / `tryResolveHumanRef`), which is unified so a stale stored
   ref always resolves to the current artifact.
3. **Codes/themes/categories keep readable slug-ids** for display + browsable
   files (ADR 0001's qualified scheme is preserved). This is *not* a move to
   mechanical ids everywhere — a code's name *is* its analytic identity; only the
   *reference key* changes from slug to SHA.

Until then, the status quo stands: slug-as-reference + **refuse-on-referrers**
for the rare id-mutating ops. This ADR is the commitment so the eventual rename
is safe **by construction**, not a retrofit.

## Why not now

Per the effort principle (§4) and addendum live-tension #4 (thin validation),
building the reference migration + a rename verb ahead of a demonstrated need is
apparatus ahead of use. No verb renames an artifact today; the active bug
(Unicode slug) is fixed without it. So: decide the model now, build it when a
rename is actually wanted (tracked as a deferred issue).

## Consequences

**Positive**
- A future rename is free and safe across codes/themes/categories/memos — no
  dangling refs, no rewrite cascade, no refusal.
- The Unicode slug fix (shipped now) closes the only live fragility immediately.
- Reaffirms the surrogate/natural-key split compost half-uses already
  (`artifact_id` is the surrogate; the slug is the natural key).

**Negative / accepted**
- Implementing it later is a migration of the `evidence` / `link` / `anchor`
  encoding (human-id → `artifact_id`) — tracked, not free.
- Frontmatter references become less human-readable (mitigated by a display hint
  alongside the SHA).

## Alternatives considered

1. **Mechanical ids everywhere (`C-NNN`, `T-NNN`).** Rejected — discards readable
   refs, the ADR 0001 qualified scheme, and browsable filenames. Memos differ
   (the title isn't identity) so they took a mechanical id; codes keep slug-ids.
2. **Keep slug-as-reference forever + refuse-on-referrers.** The interim status
   quo; works but caps renames permanently. Chosen only until the migration is
   warranted.
3. **Rewrite all referrers on each rename.** Rejected as the primary mechanism —
   O(referrers) churn and a wide failure surface; keying on the immutable SHA
   makes the rewrite unnecessary.

## Downstream

- Deferred issue: migrate references (`evidence`/`link`/`anchor`) to
  `artifact_id` + add a `rename` verb — built when a rename need is validated.
- Independent of this ADR and shipped now: Unicode-aware `slug()`.
