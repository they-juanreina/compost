import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CompostError } from '../errors.js'

export interface SessionView {
  session_id: string
  seed: string
  transcript_path: string
  transcript: unknown
  frames: Array<{ id: string; at_ms: number; trigger: string; path: string }>
}

/**
 * Read a session's transcript.json plus a derived frame index. Used by the
 * `compost session` command and the `compost_get_session` MCP tool so the host
 * agent can pull a full session into context.
 */
export function getSession(seedPath: string, sessionId: string): SessionView {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new CompostError('INVALID_INPUT', `Invalid session id: ${JSON.stringify(sessionId)}`)
  }
  const dir = join(seedPath, 'sessions', sessionId)
  if (!existsSync(dir)) {
    throw new CompostError('FILE_NOT_FOUND', `No session "${sessionId}" under ${seedPath}/sessions`)
  }
  const transcriptPath = join(dir, 'transcript.json')
  if (!existsSync(transcriptPath)) {
    throw new CompostError(
      'FILE_NOT_FOUND',
      `Session "${sessionId}" has no transcript.json yet (still queued or transcribing?)`,
    )
  }

  let transcript: unknown
  try {
    transcript = JSON.parse(readFileSync(transcriptPath, 'utf8'))
  } catch (err) {
    throw new CompostError('INVALID_INPUT', `Failed to parse ${transcriptPath}: ${String(err)}`)
  }

  return {
    session_id: sessionId,
    seed: seedPath.split('/').pop() ?? 'seed',
    transcript_path: transcriptPath,
    transcript,
    frames: deriveFrameIndex(transcript, dir),
  }
}

/**
 * Build a frame index from the transcript's frames[] (preferred) or, as a
 * fallback, from the on-disk frames/ directory. Kept lightweight — the player
 * UI (v0.2) reads richer metadata; agents just need id/at_ms/trigger/path.
 */
function deriveFrameIndex(transcript: unknown, sessionDir: string): SessionView['frames'] {
  const fromTranscript = (transcript as { frames?: unknown }).frames
  if (Array.isArray(fromTranscript)) {
    return fromTranscript
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map((f) => ({
        id: String(f.id ?? ''),
        at_ms: typeof f.at_ms === 'number' ? f.at_ms : 0,
        trigger: String(f.trigger ?? 'unknown'),
        path: String(f.path ?? ''),
      }))
  }
  // Fallback: list JPGs in frames/ if the transcript predates frame capture.
  const framesDir = join(sessionDir, 'frames')
  if (!existsSync(framesDir)) return []
  return readdirSync(framesDir)
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .map((f) => ({ id: f, at_ms: 0, trigger: 'on-disk', path: join('frames', f) }))
}
