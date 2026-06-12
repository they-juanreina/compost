import { CompostError } from '../errors.js'
import { tryResolveCodeRef } from './codeRefs.js'
import type { Author } from './events.js'
import { artifactId, openSeedEvents } from './events.js'
import { listArtifacts, type SnapshotView } from './reads.js'

/**
 * The category tier (ADR 0002): codes are grouped into categories via
 * `link(code → category)` events on a `category_link` artifact (one per
 * code↔category pair, addressed by SHA of {code, category}). The link payload
 * carries `is_primary` — exactly one primary link per code drives coverage /
 * saturation math; additional links are axial (secondary) relationships.
 *
 * is_primary is mutated by re-emitting `link` (the reducer re-initializes
 * current_state from a `link` event), so promoting/demoting never needs an
 * `update` against a create-less link artifact. `unlink` archives the relation.
 */

export const CATEGORY_LINK_KIND = 'category_link'

export interface CategoryLink {
  code: string
  category: string
  is_primary: boolean
  /** The frame this link belongs to (the category's codebook). Carried so a
   * demote (re-link) preserves it — `link` re-initializes state, not merges. */
  codebook_id?: string
  artifact_id: string
}

/** Stable address for a code↔category relationship. */
function linkId(code: string, category: string): string {
  return artifactId({ kind: CATEGORY_LINK_KIND, code, category })
}

/** Current snapshots of the seed's categories, newest activity first. */
export function listCategories(seedPath: string): SnapshotView[] {
  return listArtifacts(seedPath, 'category')
}

/**
 * Resolve a category reference (name or CAT- id) to its current snapshot.
 * Unknown refs throw, listing what's available — a typo'd category in a link
 * would silently group nothing. Returns the canonical id + codebook_id.
 */
export function resolveCategory(
  seedPath: string,
  ref: string,
): { id: string; codebook_id: string } {
  const cats = listCategories(seedPath)
  for (const snap of cats) {
    const s = snap.current_state as { id?: string; name?: string; codebook_id?: string }
    if (s.id === ref || s.name === ref || `CAT-${s.name}` === ref) {
      return { id: s.id ?? ref, codebook_id: s.codebook_id ?? 'CB-primary' }
    }
  }
  const names = cats
    .map((c) => (c.current_state as { id?: string }).id)
    .filter((id): id is string => typeof id === 'string')
  throw new CompostError(
    'INVALID_INPUT',
    `No category "${ref}" in this seed. Available: ${names.length > 0 ? names.join(', ') : '(none — create one with `compost category new <name> --definition <text>`)'}`,
  )
}

/** Active (non-unlinked) code↔category links in the seed. */
export function listCategoryLinks(seedPath: string): CategoryLink[] {
  const out: CategoryLink[] = []
  for (const snap of listArtifacts(seedPath, CATEGORY_LINK_KIND)) {
    const s = snap.current_state as {
      code?: string
      category?: string
      is_primary?: boolean
      codebook_id?: string
    }
    if (typeof s.code === 'string' && typeof s.category === 'string') {
      out.push({
        code: s.code,
        category: s.category,
        is_primary: s.is_primary === true,
        ...(typeof s.codebook_id === 'string' ? { codebook_id: s.codebook_id } : {}),
        artifact_id: snap.artifact_id,
      })
    }
  }
  return out
}

export interface LinkResult {
  code: string
  category: string
  is_primary: boolean
  /** A previously-primary link for this code that was demoted to keep the
   * one-primary-per-code invariant (its category), or null. */
  demoted?: string
}

/**
 * Link a code to a category. is_primary is true when `primary` is explicitly
 * requested, or by default when the code has no primary link yet (its first
 * category is its home). Forcing a new primary demotes the code's existing
 * primary link (append-only: a fresh `link` event re-sets is_primary=false on
 * it) so exactly one primary per code holds.
 */
export function linkCodeToCategory(
  seedPath: string,
  input: { code: string; category: string; primary?: boolean; codebookId?: string; author: Author },
): LinkResult {
  // Resolve the code ref to its canonical (qualified) id once (#269), so the
  // link payload references the same id the code is stored under and bare
  // shorthand works. Unresolved codes (event-only drafts / not yet created) are
  // allowed through with the ref unchanged.
  const resolved = tryResolveCodeRef(seedPath, input.code)
  const code = resolved?.id ?? input.code

  // A category groups codes within ONE frame (ADR 0002). If the code exists and
  // its frame differs from the category's, refuse — silently mixing frames is
  // exactly what codebook scoping (ADR 0001) exists to prevent.
  if (
    input.codebookId !== undefined &&
    resolved !== undefined &&
    resolved.codebookId !== input.codebookId
  ) {
    throw new CompostError(
      'INVALID_INPUT',
      `Code "${input.code}" is in codebook ${resolved.codebookId}, but category "${input.category}" is in ${input.codebookId}. A category groups codes within one frame.`,
    )
  }

  const links = listCategoryLinks(seedPath)
  const existingPrimary = links.find((l) => l.code === code && l.is_primary)
  const isPrimary = input.primary === true || (input.primary === undefined && !existingPrimary)

  // Uphold "exactly one primary per code": --no-primary may not strip a code's
  // last home. Allowed only when another primary (on a different category)
  // already exists to carry it.
  if (input.primary === false) {
    const otherPrimary = links.find(
      (l) => l.code === code && l.is_primary && l.category !== input.category,
    )
    if (otherPrimary === undefined) {
      throw new CompostError(
        'INVALID_INPUT',
        `Refusing --no-primary: it would leave code "${input.code}" with no primary category. A code keeps exactly one primary home — link another category with --primary first.`,
      )
    }
  }

  const events = openSeedEvents(seedPath)
  try {
    let demoted: string | undefined
    if (isPrimary && existingPrimary && existingPrimary.category !== input.category) {
      // Re-emit the old primary link with is_primary=false. `link` re-initializes
      // state (not a merge), so carry its codebook_id forward or the demote would
      // strip the frame scope (#265 review).
      events.appendEvent({
        artifact_kind: CATEGORY_LINK_KIND,
        artifact_id: existingPrimary.artifact_id,
        action: 'link',
        actor_type: input.author.actorType,
        actor_id: input.author.actorId,
        payload: {
          code,
          category: existingPrimary.category,
          ...(existingPrimary.codebook_id !== undefined
            ? { codebook_id: existingPrimary.codebook_id }
            : {}),
          is_primary: false,
        },
      })
      demoted = existingPrimary.category
    }
    events.appendEvent({
      artifact_kind: CATEGORY_LINK_KIND,
      artifact_id: linkId(code, input.category),
      action: 'link',
      actor_type: input.author.actorType,
      actor_id: input.author.actorId,
      payload: {
        code,
        category: input.category,
        ...(input.codebookId !== undefined ? { codebook_id: input.codebookId } : {}),
        is_primary: isPrimary,
      },
    })
    return {
      code,
      category: input.category,
      is_primary: isPrimary,
      ...(demoted !== undefined ? { demoted } : {}),
    }
  } finally {
    events.close()
  }
}

/** Unlink a code from a category (archives the relationship; append-only). */
export function unlinkCodeFromCategory(
  seedPath: string,
  input: { code: string; category: string; author: Author },
): { unlinked: boolean } {
  // Canonicalize the code ref so unlinking by bare shorthand finds the link
  // stored under the qualified id (#269).
  const code = tryResolveCodeRef(seedPath, input.code)?.id ?? input.code
  const id = linkId(code, input.category)
  // The active snapshot carries last_event — unlink MUST chain to it
  // (schema: endorse/reject/update/unlink reference the event being acted on).
  const snap = listArtifacts(seedPath, CATEGORY_LINK_KIND).find((s) => s.artifact_id === id)
  if (snap === undefined) return { unlinked: false }
  const events = openSeedEvents(seedPath)
  try {
    events.appendEvent({
      artifact_kind: CATEGORY_LINK_KIND,
      artifact_id: id,
      action: 'unlink',
      actor_type: input.author.actorType,
      actor_id: input.author.actorId,
      parent_event: snap.last_event,
      payload: { code, category: input.category },
    })
    return { unlinked: true }
  } finally {
    events.close()
  }
}
