import { resolve } from 'node:path'

import { CompostError } from '../errors.js'
import { isContainedUnder } from './pathSafe.js'

/**
 * Session ids are bare labels, not paths (#211 followup). A session id indexes
 * into `<seed>/sessions/<id>/`, so a value containing a path separator or a `..`
 * segment would let a write/exec path escape the seed. The read path
 * (`getSession`, session.ts) and the Docker transcriber HTTP route already
 * enforce this regex; this module is the single source of truth so every
 * write/exec entry (import, snap, native transcribe) validates identically.
 *
 * The pattern intentionally disallows `.` entirely, so `.`, `..`, and `./`
 * cannot appear — `assertSessionContained` below is belt-and-braces in the
 * spirit of `assertContainedUnder` in seedResolve.ts.
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/

/** Throw INVALID_INPUT unless `sessionId` is a bare, path-safe label. */
export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new CompostError(
      'INVALID_INPUT',
      `Invalid session id ${JSON.stringify(sessionId)} — use letters, digits, '-' or '_' only (no path separators or '..').`,
    )
  }
}

/**
 * Resolve `<seedPath>/sessions/<sessionId>` and assert it stays under the
 * seed's `sessions/` root. Returns the validated absolute directory. Catches
 * any escape the deny-list regex might miss before any fs op runs.
 */
export function assertSessionContained(seedPath: string, sessionId: string): string {
  assertSessionId(sessionId)
  const sessionsRoot = resolve(seedPath, 'sessions')
  const dir = resolve(sessionsRoot, sessionId)
  if (!isContainedUnder(sessionsRoot, dir)) {
    throw new CompostError('INVALID_INPUT', `Session id resolves outside the seed: ${dir}`)
  }
  return dir
}
