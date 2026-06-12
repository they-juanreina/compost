import { CompostError } from '../errors.js'
import { DEFAULT_CODEBOOK_ID } from './artifacts.js'
import { listArtifacts } from './reads.js'

/**
 * Qualified code references (#269, ADR 0001). Once `merge | fork | import` can
 * bring same-named codes into one seed under different frames, a code's name is
 * no longer a unique key. Option A makes the frame part of the identity:
 *
 *   canonical id : `C-<codebook-slug>/<code-slug>`   e.g. `C-primary/distrust`
 *   on disk      : `codebook/<codebook-slug>/<code-slug>.md`
 *
 * A bare `C-<code-slug>` (or a plain name) is accepted everywhere as a
 * shorthand and resolved to its frame — uniquely when only one frame holds that
 * slug, else an error that lists the qualified candidates (mirrors
 * `resolveCategory`). `resolveCodeRef` is the single choke point every consumer
 * routes through; nothing reconstructs `C-<slug>` by hand.
 */

/** `CB-epistemology` → `epistemology`; passes through a bare slug unchanged. */
export function codebookSlugOf(codebookId: string): string {
  return codebookId.startsWith('CB-') ? codebookId.slice(3) : codebookId
}

/** The qualified id for a code in a frame. */
export function qualifiedCodeId(codebookId: string, codeSlug: string): string {
  return `C-${codebookSlugOf(codebookId)}/${codeSlug}`
}

export interface ParsedCodeId {
  /** The frame slug, or undefined for a bare (un-namespaced legacy) ref. */
  codebookSlug?: string
  /** The code's own slug. */
  codeSlug: string
}

/** Split a `C-<cb>/<slug>` or bare `C-<slug>` id into its parts. A ref without
 * the `C-` prefix is treated as a bare code slug. */
export function parseCodeId(ref: string): ParsedCodeId {
  const body = ref.startsWith('C-') ? ref.slice(2) : ref
  const slash = body.indexOf('/')
  if (slash === -1) return { codeSlug: body }
  return { codebookSlug: body.slice(0, slash), codeSlug: body.slice(slash + 1) }
}

interface CodeRow {
  id: string
  name?: string
  codebookId: string
}

function listCodeRows(seedPath: string): CodeRow[] {
  const rows: CodeRow[] = []
  for (const snap of listArtifacts(seedPath, 'code')) {
    const s = snap.current_state as { id?: string; name?: string; codebook_id?: string }
    if (typeof s.id !== 'string') continue
    rows.push({
      id: s.id,
      ...(typeof s.name === 'string' ? { name: s.name } : {}),
      codebookId: s.codebook_id ?? DEFAULT_CODEBOOK_ID,
    })
  }
  return rows
}

export interface ResolvedCode {
  /** Canonical id exactly as stored (qualified for migrated codes, bare for
   * legacy ones — the bare shorthand keeps resolving during the window). */
  id: string
  codebookId: string
}

/**
 * Resolve a user-supplied code reference to its canonical code. Accepts:
 *   - the exact stored id (`C-primary/distrust` or a legacy `C-distrust`),
 *   - a qualified `C-<cb>/<slug>`,
 *   - a bare `C-<slug>` or plain name — unique-or-error across frames.
 * Throws NOT_FOUND when nothing matches, or INVALID_INPUT listing the qualified
 * candidates when a bare ref is ambiguous across frames.
 */
export function resolveCodeRef(seedPath: string, ref: string): ResolvedCode {
  const rows = listCodeRows(seedPath)

  // 1. Exact stored-id match wins outright (covers both qualified and legacy).
  const exact = rows.find((r) => r.id === ref)
  if (exact !== undefined) return { id: exact.id, codebookId: exact.codebookId }

  const want = parseCodeId(ref)
  const candidates = rows.filter((r) => {
    const have = parseCodeId(r.id)
    // A migrated code carries its frame in the id; a legacy bare code carries it
    // only in codebook_id — derive the frame slug from whichever is present, so
    // a qualified ref resolves a legacy code too (during the deprecation window).
    const rowFrameSlug = have.codebookSlug ?? codebookSlugOf(r.codebookId)
    if (want.codebookSlug !== undefined) {
      // Qualified ref: frame + slug must both match.
      return rowFrameSlug === want.codebookSlug && have.codeSlug === want.codeSlug
    }
    // Bare ref or name: match the code slug, or the code's display name.
    return have.codeSlug === want.codeSlug || r.name === ref || r.name === want.codeSlug
  })

  if (candidates.length === 1) {
    const c = candidates[0] as CodeRow
    return { id: c.id, codebookId: c.codebookId }
  }
  if (candidates.length === 0) {
    const known = rows.map((r) => r.id)
    throw new CompostError(
      'INVALID_INPUT',
      `No code "${ref}" in this seed.${known.length > 0 ? ` Known codes: ${known.join(', ')}.` : ''}`,
    )
  }
  // Ambiguous bare ref across frames — make the caller qualify it.
  throw new CompostError(
    'INVALID_INPUT',
    `Code "${ref}" is ambiguous across codebooks: ${candidates.map((c) => c.id).join(', ')}. Qualify it as C-<codebook>/<code>.`,
  )
}
