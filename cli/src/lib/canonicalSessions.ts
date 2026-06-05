import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Single source of truth for "is this subdir of `sessions/` a real session?"
 * Shared between `compost status` and `compost saturate` so they can't disagree
 * on the session set (#166 — saturate was counting every subdir as a session,
 * while status correctly skipped non-canonical folders like `Transcripts/`).
 *
 * A subdir qualifies when ANY holds:
 *   - the name matches `S\d+` (canonical id shape from ingest-watcher), OR
 *   - it contains a `transcript.json` (already transcribed), OR
 *   - it contains a `source.<ext>` file (queued for transcription).
 *
 * `_inbox/` and dotfiles are filtered out by the listing helper, not the
 * predicate; callers that traverse `sessions/` directly should handle those.
 */
export const CANONICAL_SESSION_ID_RE = /^S\d+$/

export function isCanonicalSession(absDir: string, name: string): boolean {
  if (CANONICAL_SESSION_ID_RE.test(name)) return true
  if (existsSync(join(absDir, 'transcript.json'))) return true
  // source.<ext> is written by processInbox before the dir is canonicalized.
  return readdirSync(absDir).some((f) => f.startsWith('source.'))
}

/**
 * List the canonical session-id directory names under `<seed>/sessions/`,
 * skipping `_inbox/`, dotfiles, files, and non-canonical folders. Returns the
 * directory names (not absolute paths). Order is filesystem-dependent — sort
 * at the call site if chronological ordering matters.
 */
export function listCanonicalSessionIds(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return []
  const out: string[] = []
  for (const entry of readdirSync(sessionsDir)) {
    if (entry.startsWith('.') || entry === '_inbox') continue
    const abs = join(sessionsDir, entry)
    if (!statSync(abs).isDirectory()) continue
    if (!isCanonicalSession(abs, entry)) continue
    out.push(entry)
  }
  return out
}
