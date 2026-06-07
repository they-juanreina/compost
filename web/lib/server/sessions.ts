import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { getSession, listSessions } from '@they-juanreina/compost-cli/engine'

import { resolveSeed } from '../actions.js'
import { ApiError } from './http.js'

/** List a seed's sessions with lightweight counts (#120, seed home page). */
export function listSessionsForSeed(seed: string) {
  return listSessions(resolveSeed(seed))
}

/** Read a session's transcript.json + derived frame index (#120 player). */
export function getSessionForSeed(seed: string, sessionId: string) {
  return getSession(resolveSeed(seed), sessionId)
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Serve a single frame image by its id. The id is looked up in the session's
 * frame index (never used as a path), and the resolved file must live inside the
 * session directory — frame `path` values come from two bases historically
 * (seed-relative in transcript.json, session-relative in the on-disk fallback),
 * so we try both and accept only a contained match. Defends against traversal
 * even if a transcript is hand-edited.
 */
export function readFrame(
  seed: string,
  sessionId: string,
  frameId: string,
): { body: Buffer; contentType: string } {
  if (/[\\/]|\.\./.test(frameId)) {
    throw new ApiError('INVALID_INPUT', `Invalid frame id: ${JSON.stringify(frameId)}`)
  }
  const seedPath = resolveSeed(seed)
  const session = getSession(seedPath, sessionId) // throws NOT_FOUND for a missing session
  const frame = session.frames.find((f) => f.id === frameId)
  if (frame === undefined || frame.path === '') {
    throw new ApiError('NOT_FOUND', `No frame "${frameId}" in session "${sessionId}"`)
  }

  const sessionDir = join(seedPath, 'sessions', sessionId)
  const candidates = [resolve(seedPath, frame.path), resolve(sessionDir, frame.path)]
  const abs = candidates.find((c) => isContained(sessionDir, c) && existsSync(c))
  if (abs === undefined) {
    throw new ApiError('NOT_FOUND', `Frame file missing on disk for "${frameId}"`)
  }

  const dot = abs.lastIndexOf('.')
  const ext = dot >= 0 ? abs.slice(dot).toLowerCase() : ''
  return { body: readFileSync(abs), contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' }
}
