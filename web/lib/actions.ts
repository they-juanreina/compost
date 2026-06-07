/**
 * Server actions library (#119) — the single provenance-aware write path for
 * the web app. Every mutation routes through here into the CLI engine
 * (`@they-juanreina/compost-cli/engine`), so web-created artifacts are
 * byte-identical in file + event shape to CLI-created ones. No write logic is
 * reimplemented; this layer only resolves the seed, validates request bodies,
 * and adds optimistic-lock concurrency the engine has no notion of.
 */
import {
  type Author,
  type CreatedArtifact,
  createCode,
  createHighlight,
  createTheme,
  endorseArtifact,
  getArtifact,
  listArtifacts,
  rejectArtifact,
  resolveSeedPath,
  type SnapshotView,
  updateArtifact,
} from '@they-juanreina/compost-cli/engine'

import { ApiError } from './server/http.js'

export type ArtifactKind = 'highlight' | 'code' | 'theme'

const SEGMENT_TO_KIND: Record<string, ArtifactKind> = {
  highlights: 'highlight',
  codes: 'code',
  themes: 'theme',
}

/** Map a route segment (`highlights`) to an artifact kind (`highlight`). */
export function kindFromSegment(segment: string): ArtifactKind {
  const kind = SEGMENT_TO_KIND[segment]
  if (kind === undefined) {
    throw new ApiError('NOT_FOUND', `Unknown artifact collection "${segment}"`)
  }
  return kind
}

/** Root that contains `Seeds/`. Overridable for tests / `compost serve --root`. */
function seedRoot(): string {
  return process.env.COMPOST_ROOT ?? process.cwd()
}

/** Resolve a seed name to its on-disk path (path-traversal hardened in the
 * engine). Throws NOT_FOUND (via CompostError mapping) for a missing seed. */
export function resolveSeed(seed: string): string {
  return resolveSeedPath(seedRoot(), seed)
}

// ----------------------------------------------------------------- validation

function reqString(body: Record<string, unknown>, field: string): string {
  const v = body[field]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ApiError('SCHEMA_ERROR', `Field "${field}" must be a non-empty string`)
  }
  return v
}

function optStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const v = body[field]
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ApiError('SCHEMA_ERROR', `Field "${field}" must be an array of strings`)
  }
  return v as string[]
}

function reqSpan(body: Record<string, unknown>): [number, number] {
  const v = body.span
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number') {
    throw new ApiError('SCHEMA_ERROR', 'Field "span" must be [number, number]')
  }
  return [v[0], v[1]]
}

// --------------------------------------------------------------------- create

export interface CreateResult extends CreatedArtifact {
  snapshot: SnapshotView | null
}

/** Create an artifact of `kind` from a validated request body, attributed to
 * `author`. Dispatches to the matching engine create fn. */
export function createArtifact(
  seed: string,
  kind: ArtifactKind,
  author: Author,
  body: Record<string, unknown>,
): CreateResult {
  const seedPath = resolveSeed(seed)
  let created: CreatedArtifact
  switch (kind) {
    case 'highlight':
      created = createHighlight(seedPath, {
        sessionId: reqString(body, 'sessionId'),
        utteranceId: reqString(body, 'utteranceId'),
        span: reqSpan(body),
        text: reqString(body, 'text'),
        author,
      })
      break
    case 'code': {
      const evidence = optStringArray(body, 'evidence')
      created = createCode(seedPath, {
        name: reqString(body, 'name'),
        definition: reqString(body, 'definition'),
        author,
        ...(evidence !== undefined ? { evidence } : {}),
      })
      break
    }
    case 'theme': {
      const codes = optStringArray(body, 'codes')
      created = createTheme(seedPath, {
        name: reqString(body, 'name'),
        summary: reqString(body, 'summary'),
        author,
        ...(codes !== undefined ? { codes } : {}),
      })
      break
    }
  }
  return { ...created, snapshot: getArtifact(seedPath, kind, created.id) }
}

// ----------------------------------------------------------------- read

export function listArtifactsOfKind(
  seed: string,
  kind: ArtifactKind,
  opts: { includeArchived?: boolean } = {},
): SnapshotView[] {
  return listArtifacts(resolveSeed(seed), kind, opts)
}

export function getArtifactByRef(seed: string, kind: ArtifactKind, ref: string): SnapshotView {
  const snapshot = getArtifact(resolveSeed(seed), kind, ref)
  if (snapshot === null) {
    throw new ApiError('NOT_FOUND', `No ${kind} "${ref}" in seed "${seed}"`)
  }
  return snapshot
}

// ------------------------------------------------------- optimistic concurrency

/**
 * Guard a mutation against a stale client. When `expectedVersion` is provided
 * (e.g. `If-Match`), it must equal the artifact's current snapshot version or we
 * raise 409 CONFLICT with the current snapshot so the client can reconcile.
 * Also resolves the ref to the current snapshot (404 if it doesn't exist).
 */
function requireVersion(
  seedPath: string,
  kind: ArtifactKind,
  ref: string,
  expectedVersion: number | undefined,
): SnapshotView {
  const current = getArtifact(seedPath, kind, ref)
  if (current === null) {
    throw new ApiError('NOT_FOUND', `No ${kind} "${ref}"`)
  }
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw new ApiError(
      'CONFLICT',
      `Stale write: expected version ${expectedVersion}, current is ${current.version}`,
      { current },
    )
  }
  return current
}

// --------------------------------------------------------------- endorse/reject/update

export function endorse(
  seed: string,
  kind: ArtifactKind,
  ref: string,
  researcherId: string,
  expectedVersion?: number,
): SnapshotView {
  const seedPath = resolveSeed(seed)
  requireVersion(seedPath, kind, ref, expectedVersion)
  endorseArtifact(seedPath, ref, researcherId)
  return getArtifactByRef(seed, kind, ref)
}

export function reject(
  seed: string,
  kind: ArtifactKind,
  ref: string,
  researcherId: string,
  opts: { expectedVersion?: number; note?: string } = {},
): SnapshotView {
  const seedPath = resolveSeed(seed)
  requireVersion(seedPath, kind, ref, opts.expectedVersion)
  rejectArtifact(seedPath, ref, researcherId, opts.note)
  // Read including archived — a freshly-rejected artifact is archived.
  const snapshot = getArtifact(seedPath, kind, ref)
  if (snapshot === null) throw new ApiError('NOT_FOUND', `No ${kind} "${ref}"`)
  return snapshot
}

export function update(
  seed: string,
  kind: ArtifactKind,
  ref: string,
  author: Author,
  patch: { field: string; before?: unknown; after: unknown },
  expectedVersion?: number,
): SnapshotView {
  const seedPath = resolveSeed(seed)
  requireVersion(seedPath, kind, ref, expectedVersion)
  updateArtifact(seedPath, ref, patch, author)
  return getArtifactByRef(seed, kind, ref)
}
