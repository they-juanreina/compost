import { CompostError } from '../errors.js'
import { DEFAULT_CODEBOOK_ID, resolveCodebookId } from './artifacts.js'
import { listCategoryLinks, resolveCategory } from './categories.js'
import { tryResolveCodeRef } from './codeRefs.js'
import { listArtifacts } from './reads.js'

/**
 * Theme evidence (ADR 0002 §1, #266). A theme's support is no longer a flat
 * `codes[]` list — it is a heterogeneous set of `{kind: code | category}`
 * references, so a theme can rest on first-cycle codes, second-cycle
 * categories, or a mix. A `category` ref stands in for all of its member codes
 * (resolved through `link(code → category)` events).
 *
 * Frontmatter encoding. The repo's frontmatter is a hand-rolled line format
 * (no YAML lib in the parsers), and `formatYamlValue` can serialize a string
 * array but not an array of objects. So each evidence entry is encoded as a
 * single colon-delimited token `kind:ref:codebook_id` and the set rides the
 * existing `[a, b, c]` inline-array path. kind ∈ {code, category}, and refs /
 * codebook ids are slugs (`C-…`, `CAT-…`, `CB-…`) with no colons, so the
 * delimiter is unambiguous.
 */

export type ThemeEvidenceKind = 'code' | 'category' | 'memo'

export interface ThemeEvidence {
  kind: ThemeEvidenceKind
  ref: string
  /** The frame this code/category belongs to. Present on freshly-created
   * themes; absent (undefined) when lazy-mapped from a legacy `codes[]` theme
   * whose per-code frame was never recorded on the theme, or for a `memo`
   * entry, which is frame-neutral (a memo is an analytic annotation, not a lens
   * — ADR 0004 §3–4). */
  codebookId?: string
}

const EVIDENCE_KINDS: readonly ThemeEvidenceKind[] = ['code', 'category', 'memo']

/** Encode one evidence entry as a frontmatter token: `kind:ref:codebook_id`. */
export function encodeEvidence(e: ThemeEvidence): string {
  return `${e.kind}:${e.ref}:${e.codebookId ?? ''}`
}

/** Decode a `kind:ref:codebook_id` token. Tolerant of a missing trailing
 * codebook id (legacy / hand-edited). Returns null for an unrecognized kind so
 * a malformed token is skipped rather than corrupting the set. */
export function decodeEvidence(token: string): ThemeEvidence | null {
  const parts = token.split(':')
  const [kind, ref, codebookId] = parts
  if (kind === undefined || ref === undefined) return null
  if (!EVIDENCE_KINDS.includes(kind as ThemeEvidenceKind)) return null
  if (ref.length === 0) return null
  return {
    kind: kind as ThemeEvidenceKind,
    ref,
    ...(codebookId !== undefined && codebookId.length > 0 ? { codebookId } : {}),
  }
}

/** Parsed theme frontmatter, the subset themes care about. Both `saturate` and
 * the create path read through this so the lazy-map lives in exactly one place. */
export interface ThemeFrontmatter {
  evidence?: string[]
  codes?: string[]
}

/**
 * Resolve a theme's evidence set, preferring the new `evidence[]` and lazily
 * mapping a legacy `codes[]` theme to `evidence: codes.map(c => ({kind:'code',
 * ref:c}))` (ADR 0002 §1 migration note). This is the deprecation-window shim:
 * old themes keep working unread-modified; new themes carry evidence natively.
 */
export function loadThemeEvidence(fm: ThemeFrontmatter): ThemeEvidence[] {
  if (fm.evidence !== undefined && fm.evidence.length > 0) {
    return fm.evidence.map(decodeEvidence).filter((e): e is ThemeEvidence => e !== null)
  }
  if (fm.codes !== undefined) {
    return fm.codes.map((ref) => ({ kind: 'code' as const, ref }))
  }
  return []
}

/**
 * Resolve every evidence entry to the set of first-cycle code ids it stands
 * for. A `code` entry resolves to itself; a `category` entry resolves to its
 * **primary-linked** member codes only (`link(code → category)` with
 * `is_primary`) — per ADR 0002, is_primary drives coverage/saturation math, so
 * an axial (secondary) membership does not inflate a theme's session coverage.
 * Used by `saturate` to walk evidence → code → highlight → session uniformly
 * across the heterogeneous set.
 */
export function evidenceToCodeIds(seedPath: string, evidence: ThemeEvidence[]): string[] {
  let links: ReturnType<typeof listCategoryLinks> | null = null
  const out = new Set<string>()
  for (const e of evidence) {
    // The no-inflate invariant (ADR 0004 §4): a memo cited as theme evidence is
    // an analytic annotation, not a participant utterance — it contributes no
    // codes, so it never lifts saturation / coverage math.
    if (e.kind === 'memo') continue
    if (e.kind === 'code') {
      // Canonicalize to the qualified code id (#269) so a bare-or-qualified
      // theme ref joins the same code files saturate reads, and matches the
      // qualified ids category links now store.
      out.add(tryResolveCodeRef(seedPath, e.ref)?.id ?? e.ref)
      continue
    }
    // category → member codes. Resolve the ref to a canonical CAT- id first so
    // a name-or-id evidence ref both match the link rows (which store ids).
    links ??= listCategoryLinks(seedPath)
    let categoryId = e.ref
    try {
      categoryId = resolveCategory(seedPath, e.ref).id
    } catch {
      // Unknown category (deleted/renamed). Fall back to the raw ref so a
      // direct id match still works; if nothing matches it contributes no codes.
    }
    for (const link of links) {
      // Canonicalize the link's code too (#269): a pre-migration link stores a
      // bare id, but the code file it points at may now be qualified.
      if (link.category === categoryId && link.is_primary) {
        out.add(tryResolveCodeRef(seedPath, link.code)?.id ?? link.code)
      }
    }
  }
  return [...out]
}

/** A code ref (name or id) resolved to its canonical id + frame, or undefined
 * when the code has no artifact yet (event-only scanner draft / not created). */
function resolveCodeFrame(
  seedPath: string,
  ref: string,
): { id: string; codebookId: string } | undefined {
  for (const snap of listArtifacts(seedPath, 'code')) {
    const s = snap.current_state as { id?: string; name?: string; codebook_id?: string }
    if (s.id === ref || s.name === ref || `C-${s.name}` === ref) {
      return { id: s.id ?? ref, codebookId: s.codebook_id ?? DEFAULT_CODEBOOK_ID }
    }
  }
  return undefined
}

export interface ResolvedThemeEvidence {
  /** Evidence entries with a concrete frame stamped on each lens-bearing
   * (code/category) entry. `memo` entries are frame-neutral, so their
   * `codebookId` may be absent. */
  evidence: ThemeEvidence[]
  /** The theme's frame: a CB- id when single-lens, or null when cross-lens. */
  codebookId: string | null
}

/**
 * Resolve a create-time evidence set: stamp each entry with its frame, then
 * determine the theme's `codebook_id` and enforce the cross-lens invariant
 * (ADR 0002 §1, #266):
 *
 * - `requested === undefined` → infer: one frame ⇒ that frame; ≥2 ⇒ cross-lens.
 * - `requested === null` → cross-lens; require ≥2 distinct frames in evidence.
 * - `requested === <CB-id>` → single-lens; all evidence must be in that frame.
 */
export function resolveThemeEvidence(
  seedPath: string,
  evidence: ThemeEvidence[],
  requested: string | null | undefined,
): ResolvedThemeEvidence {
  // Lens-bearing evidence (code/category) defines the theme's frame; `memo`
  // entries are analytic annotations that ride along frame-neutral (ADR 0004
  // §3). Frame enforcement runs over the lens entries only, so a theme with no
  // codes/categories — even if it cites memos — takes the evidence-less path.
  const lensCount = evidence.filter((e) => e.kind !== 'memo').length
  if (lensCount === 0) {
    const codebookId =
      requested === null || requested === undefined ? null : resolveCodebookId(seedPath, requested)
    return { evidence, codebookId }
  }
  const stamped: ThemeEvidence[] = evidence.map((e) => {
    if (e.codebookId !== undefined) return { ...e, codebookId: e.codebookId }
    if (e.kind === 'memo') return e // frame-neutral
    if (e.kind === 'category') {
      return { ...e, codebookId: resolveCategory(seedPath, e.ref).codebook_id }
    }
    const frame = resolveCodeFrame(seedPath, e.ref)
    return { ...e, codebookId: frame?.codebookId ?? DEFAULT_CODEBOOK_ID }
  })
  const frames = new Set(
    stamped
      .filter((e) => e.kind !== 'memo')
      .map((e) => e.codebookId)
      .filter((f): f is string => f !== undefined),
  )

  if (requested === null) {
    if (frames.size < 2) {
      throw new CompostError(
        'INVALID_INPUT',
        `A cross-lens theme must cite evidence from ≥2 codebooks; this evidence is all in ${[...frames].join(', ')}. Scope it to that codebook instead, or add evidence from another lens.`,
      )
    }
    return { evidence: stamped, codebookId: null }
  }

  if (requested !== undefined) {
    const scoped = resolveCodebookId(seedPath, requested)
    const outsiders = [...frames].filter((f) => f !== scoped)
    if (outsiders.length > 0) {
      throw new CompostError(
        'INVALID_INPUT',
        `Theme is scoped to ${scoped} but cites evidence from ${outsiders.join(', ')}. A single-lens theme stays within its frame — pass --cross-lens for a theme that spans codebooks.`,
      )
    }
    return { evidence: stamped, codebookId: scoped }
  }

  // Inferred (neither --codebook nor --cross-lens given). A single shared frame
  // scopes the theme to it; evidence spanning ≥2 frames is NOT silently made
  // cross-lens — cross-lens is an explicit analytic claim, so require the flag.
  if (frames.size > 1) {
    throw new CompostError(
      'INVALID_INPUT',
      `Theme evidence spans ${frames.size} codebooks (${[...frames].join(', ')}). Pass --cross-lens for a theme that spans frames, or --codebook <CB-id> to scope it to one.`,
    )
  }
  return { evidence: stamped, codebookId: [...frames][0] ?? null }
}
