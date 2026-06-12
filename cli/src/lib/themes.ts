import { CompostError } from '../errors.js'
import { DEFAULT_CODEBOOK_ID, resolveCodebookId } from './artifacts.js'
import { listCategoryLinks, resolveCategory } from './categories.js'
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

export type ThemeEvidenceKind = 'code' | 'category'

export interface ThemeEvidence {
  kind: ThemeEvidenceKind
  ref: string
  /** The frame this code/category belongs to. Present on freshly-created
   * themes; absent (undefined) when lazy-mapped from a legacy `codes[]` theme
   * whose per-code frame was never recorded on the theme. */
  codebookId?: string
}

const EVIDENCE_KINDS: readonly ThemeEvidenceKind[] = ['code', 'category']

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
 * for. A `code` entry resolves to itself; a `category` entry resolves to all
 * of its currently-linked member codes (`link(code → category)` events). Used
 * by `saturate` to walk evidence → code → highlight → session uniformly across
 * the heterogeneous set.
 */
export function evidenceToCodeIds(seedPath: string, evidence: ThemeEvidence[]): string[] {
  let links: ReturnType<typeof listCategoryLinks> | null = null
  const out = new Set<string>()
  for (const e of evidence) {
    if (e.kind === 'code') {
      out.add(e.ref)
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
      if (link.category === categoryId) out.add(link.code)
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
  /** Evidence entries with a concrete frame stamped on each. */
  evidence: Required<ThemeEvidence>[]
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
  // An evidence-less theme is a degenerate but supported state (e.g. a theme
  // created in the web UI before codes are attached). Skip frame enforcement;
  // resolve the requested frame if given, else leave it unscoped (null).
  if (evidence.length === 0) {
    if (requested === null || requested === undefined) return { evidence: [], codebookId: null }
    return { evidence: [], codebookId: resolveCodebookId(seedPath, requested) }
  }
  const stamped: Required<ThemeEvidence>[] = evidence.map((e) => {
    if (e.codebookId !== undefined) return { ...e, codebookId: e.codebookId }
    if (e.kind === 'category') {
      return { ...e, codebookId: resolveCategory(seedPath, e.ref).codebook_id }
    }
    const frame = resolveCodeFrame(seedPath, e.ref)
    return { ...e, codebookId: frame?.codebookId ?? DEFAULT_CODEBOOK_ID }
  })
  const frames = new Set(stamped.map((e) => e.codebookId))

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

  // Inferred: collapse to the sole frame, or mark cross-lens when evidence spans
  // multiple. (A friendly default; pass --codebook / --cross-lens to be explicit.)
  return { evidence: stamped, codebookId: frames.size === 1 ? ([...frames][0] ?? null) : null }
}
