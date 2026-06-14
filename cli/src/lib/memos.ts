import { CompostError } from '../errors.js'
import { resolveCodebookId } from './artifacts.js'
import { resolveCategory } from './categories.js'
import { tryResolveCodeRef } from './codeRefs.js'
import { getArtifact, listArtifacts, type SnapshotView } from './reads.js'

/**
 * Analytic memos (ADR 0004). A memo is the analyst's dated, evolving
 * interpretive record — Saldaña's "site of conversation with ourselves about our
 * data." It is a first-class artifact (`M-<slug>`, `synthesis/memos/`) like every
 * other: SHA-addressed, event-logged, researcher-authored or AI-drafted behind
 * the `[draft]`→endorse gate. compost stores and versions the interpretation; it
 * never authors it.
 *
 * Two relationships, in opposite directions:
 *
 * - **anchors (outbound)** — what this memo is *about*: a heterogeneous set of
 *   `{kind, ref}` pointing at highlights, codes, categories, themes, codebooks,
 *   or other memos (Saldaña's "metamemos"). Zero anchors is valid — a
 *   project-level reflexive memo. Encoded exactly like theme evidence (a
 *   colon-delimited `kind:ref:codebook_id` token riding the inline-array
 *   frontmatter path), so the on-disk format stays uniform across artifacts.
 * - **codable (inbound)** — because "memos are data" (Saldaña), a memo is itself
 *   a valid evidence/coding target; that lives on the theme/code evidence side
 *   (ADR 0004 §3) and is excluded from coverage math (§4).
 */

export const MEMO_ANCHOR_KINDS = [
  'highlight',
  'code',
  'category',
  'theme',
  'codebook',
  'memo',
] as const
export type MemoAnchorKind = (typeof MEMO_ANCHOR_KINDS)[number]

/** A reduction of Saldaña's ~11 reflection categories to the load-bearing few —
 * a constrained set, not a free string (§9). `freeform` is the default catch-all
 * (the "dump your brain" memo). */
export const MEMO_TYPES = [
  'code',
  'category',
  'theme',
  'reflexive',
  'method',
  'theory',
  'freeform',
] as const
export type MemoType = (typeof MEMO_TYPES)[number]
export const DEFAULT_MEMO_TYPE: MemoType = 'freeform'

export interface MemoAnchor {
  kind: MemoAnchorKind
  ref: string
  /** The frame the anchored artifact belongs to, when it has one (code /
   * category / frame-scoped artifacts). Absent for frame-less anchors
   * (highlight) or when the target could not be resolved. */
  codebookId?: string
}

/** Encode one anchor as a frontmatter token: `kind:ref:codebook_id`. Mirrors
 * theme evidence so both ride the same inline-array path (refs are slugs with no
 * colons, so the delimiter is unambiguous). */
export function encodeAnchor(a: MemoAnchor): string {
  return `${a.kind}:${a.ref}:${a.codebookId ?? ''}`
}

/** Decode a `kind:ref:codebook_id` token. Tolerant of a missing trailing
 * codebook id; returns null for an unrecognized kind so a malformed token is
 * skipped rather than corrupting the set. */
export function decodeAnchor(token: string): MemoAnchor | null {
  const [kind, ref, codebookId] = token.split(':')
  if (kind === undefined || ref === undefined) return null
  if (!MEMO_ANCHOR_KINDS.includes(kind as MemoAnchorKind)) return null
  if (ref.length === 0) return null
  return {
    kind: kind as MemoAnchorKind,
    ref,
    ...(codebookId !== undefined && codebookId.length > 0 ? { codebookId } : {}),
  }
}

/**
 * Coerce one stored anchor to a structured `MemoAnchor`, tolerating both
 * representations: the **event payload** stores anchors as objects
 * `{kind, ref, codebook_id}` (what the reducer hands back in `current_state`),
 * while the **markdown frontmatter** stores them as `kind:ref:codebook_id`
 * tokens. Returns null for anything malformed so a bad entry is skipped rather
 * than corrupting the set.
 */
function toAnchor(a: unknown): MemoAnchor | null {
  if (typeof a === 'string') return decodeAnchor(a)
  if (a !== null && typeof a === 'object') {
    const o = a as { kind?: unknown; ref?: unknown; codebook_id?: unknown; codebookId?: unknown }
    if (typeof o.kind !== 'string' || typeof o.ref !== 'string') return null
    if (!MEMO_ANCHOR_KINDS.includes(o.kind as MemoAnchorKind)) return null
    if (o.ref.length === 0) return null
    const cb = o.codebook_id ?? o.codebookId
    return {
      kind: o.kind as MemoAnchorKind,
      ref: o.ref,
      ...(typeof cb === 'string' && cb.length > 0 ? { codebookId: cb } : {}),
    }
  }
  return null
}

/** Coerce a stored anchors list (object or token form) to structured anchors. */
export function loadMemoAnchors(anchors: unknown): MemoAnchor[] {
  if (!Array.isArray(anchors)) return []
  return anchors.map(toAnchor).filter((a): a is MemoAnchor => a !== null)
}

/** Canonicalize one anchor: resolve code/category refs to their stored id and
 * stamp the frame where the target has one. Tolerant — an unresolved ref (e.g.
 * an event-only scanner draft, or an artifact created later in the same batch)
 * is kept as-is rather than rejected, mirroring theme evidence resolution. */
function stampAnchor(seedPath: string, a: MemoAnchor): MemoAnchor {
  if (a.codebookId !== undefined) return a
  if (a.kind === 'code') {
    const r = tryResolveCodeRef(seedPath, a.ref)
    return r === undefined ? a : { kind: 'code', ref: r.id, codebookId: r.codebookId }
  }
  if (a.kind === 'category') {
    try {
      const c = resolveCategory(seedPath, a.ref)
      return { kind: 'category', ref: c.id, codebookId: c.codebook_id }
    } catch {
      return a
    }
  }
  return a
}

export interface ResolvedMemoAnchors {
  anchors: MemoAnchor[]
  /** The memo's frame: a CB- id when scoped to one lens, or null for a
   * cross-frame / project-level memo. Memos are reflective and may freely span
   * frames, so (unlike a cross-lens theme) spanning ≥2 frames is not an error —
   * it simply yields a frame-less (null) memo. */
  codebookId: string | null
}

/**
 * Resolve a create-time anchor set: canonicalize + frame-stamp each anchor, then
 * settle the memo's `codebook_id`:
 *
 * - `requested === <CB-id|name>` → that frame (validated to exist).
 * - `requested === null` → explicit cross-frame / project-level memo.
 * - `requested === undefined` → infer: a single shared frame across the anchors
 *   scopes the memo to it; zero or ≥2 frames leaves it frame-less (null).
 */
export function resolveMemoAnchors(
  seedPath: string,
  anchors: MemoAnchor[],
  requested: string | null | undefined,
): ResolvedMemoAnchors {
  const stamped = anchors.map((a) => stampAnchor(seedPath, a))
  let codebookId: string | null
  if (requested === null) {
    codebookId = null
  } else if (requested !== undefined) {
    codebookId = resolveCodebookId(seedPath, requested)
  } else {
    const frames = new Set(
      stamped.map((a) => a.codebookId).filter((f): f is string => f !== undefined),
    )
    codebookId = frames.size === 1 ? (([...frames][0] as string) ?? null) : null
  }
  return { anchors: stamped, codebookId }
}

/** Validate a memo type, throwing a structured, listing error (§10). */
export function assertMemoType(type: string): MemoType {
  if (!MEMO_TYPES.includes(type as MemoType)) {
    throw new CompostError(
      'INVALID_INPUT',
      `Invalid memo type ${JSON.stringify(type)}. A memo's type is one of: ${MEMO_TYPES.join(' | ')}.`,
    )
  }
  return type as MemoType
}

export interface MemoView {
  id: string
  type: MemoType
  title: string
  content: string
  anchors: MemoAnchor[]
  /** Frame scope; null for a cross-frame / project-level memo. */
  codebookId: string | null
  artifact_id: string
  /** false while an AI-drafted memo is still `[draft]`; true once a researcher
   * authored or endorsed it. */
  human_approved: boolean
  archived: boolean
  last_event_ts: string
}

/** Project a memo snapshot to a typed view. */
function snapshotToMemo(snap: SnapshotView): MemoView {
  const s = snap.current_state as {
    id?: string
    type?: string
    title?: string
    content?: string
    anchors?: unknown
    codebook_id?: string | null
  }
  const type =
    s.type !== undefined && MEMO_TYPES.includes(s.type as MemoType)
      ? (s.type as MemoType)
      : DEFAULT_MEMO_TYPE
  return {
    id: s.id ?? snap.artifact_id,
    type,
    title: s.title ?? '',
    content: s.content ?? '',
    anchors: loadMemoAnchors(s.anchors),
    codebookId: s.codebook_id ?? null,
    artifact_id: snap.artifact_id,
    human_approved: snap.human_approved,
    archived: snap.archived,
    last_event_ts: snap.last_event_ts,
  }
}

/** Every memo's current snapshot, newest activity first. Archived (rejected)
 * memos are excluded unless `includeArchived` is set. */
export function listMemos(seedPath: string, opts: { includeArchived?: boolean } = {}): MemoView[] {
  return listArtifacts(seedPath, 'memo', opts).map(snapshotToMemo)
}

/** A single memo by ref (its `M-` id or a SHA prefix), or null when absent. */
export function getMemo(seedPath: string, ref: string): MemoView | null {
  const snap = getArtifact(seedPath, 'memo', ref)
  return snap === null ? null : snapshotToMemo(snap)
}

/**
 * The memos anchored to a given artifact ref — the backward-link query (ADR 0004
 * §3). Canonicalizes a bare/qualified code ref so a memo anchored to the
 * qualified id is found by either form. Used by `compost memo list --about` and
 * by code/category/theme views surfacing "memos about this".
 */
export function memosAbout(
  seedPath: string,
  ref: string,
  opts: { includeArchived?: boolean } = {},
): MemoView[] {
  const canonicalCode = tryResolveCodeRef(seedPath, ref)?.id
  const targets = new Set<string>([ref, ...(canonicalCode !== undefined ? [canonicalCode] : [])])
  return listMemos(seedPath, opts).filter((m) =>
    m.anchors.some(
      (a) => targets.has(a.ref) || (canonicalCode !== undefined && a.ref === canonicalCode),
    ),
  )
}
