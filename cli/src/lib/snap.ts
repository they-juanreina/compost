import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CompostError } from '../errors.js'

export interface SnapResult {
  session_id: string
  frame_id: string
  at_ms: number
  path: string
  existed: boolean
}

const FRAME_WIDTH = 640
const FRAME_HEIGHT = 360

/** Parse mm:ss, hh:mm:ss, or raw ms (integer) into milliseconds. */
export function parseTimestamp(input: string): number {
  const raw = input.trim()
  if (/^\d+$/.test(raw)) return Number(raw)
  const parts = raw.split(':')
  if (parts.length === 2 || parts.length === 3) {
    const nums = parts.map((p) => {
      if (!/^\d+(\.\d+)?$/.test(p))
        throw new CompostError('INVALID_INPUT', `Bad time component "${p}"`)
      return Number(p)
    })
    let seconds = 0
    if (nums.length === 3) seconds = nums[0]! * 3600 + nums[1]! * 60 + nums[2]!
    else seconds = nums[0]! * 60 + nums[1]!
    return Math.round(seconds * 1000)
  }
  throw new CompostError(
    'INVALID_INPUT',
    `Unrecognized timestamp "${input}" (use ms, mm:ss, or hh:mm:ss)`,
  )
}

function padMs(ms: number): string {
  return String(ms).padStart(9, '0')
}

function findSource(sessionDir: string): string | null {
  if (!existsSync(sessionDir)) return null
  const match = readdirSync(sessionDir).find((f) => f.startsWith('source.'))
  return match !== undefined ? join(sessionDir, match) : null
}

function hasVideoStream(path: string, runner: Runner): boolean {
  try {
    const out = runner('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      path,
    ])
    return out.trim().includes('video')
  } catch {
    return false
  }
}

export type Runner = (cmd: string, args: string[]) => string

const defaultRunner: Runner = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' })

export interface SnapOptions {
  runner?: Runner
}

export function snap(
  seedPath: string,
  sessionId: string,
  at: string,
  opts: SnapOptions = {},
): SnapResult {
  const runner = opts.runner ?? defaultRunner
  const atMs = parseTimestamp(at)
  const sessionDir = join(seedPath, 'sessions', sessionId)
  const source = findSource(sessionDir)
  if (source === null) {
    throw new CompostError('FILE_NOT_FOUND', `No source media in ${sessionDir}`)
  }
  if (!hasVideoStream(source, runner)) {
    throw new CompostError('INVALID_INPUT', `${source} has no video stream; cannot snap a frame`)
  }

  const rel = `sessions/${sessionId}/frames/${padMs(atMs)}.jpg`
  const absPath = join(seedPath, rel)
  const frameId = `FR-${padMs(atMs)}`

  if (existsSync(absPath)) {
    return { session_id: sessionId, frame_id: frameId, at_ms: atMs, path: rel, existed: true }
  }

  mkdirSync(join(sessionDir, 'frames'), { recursive: true })
  runner('ffmpeg', [
    '-y',
    '-ss',
    (atMs / 1000).toFixed(3),
    '-i',
    source,
    '-frames:v',
    '1',
    '-vf',
    `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}`,
    '-q:v',
    '4',
    absPath,
  ])
  if (!existsSync(absPath)) {
    throw new CompostError('IO_ERROR', `ffmpeg did not produce a frame at ${atMs}ms`)
  }

  indexFrame(sessionDir, { id: frameId, at_ms: atMs, path: rel, trigger: 'manual' })
  return { session_id: sessionId, frame_id: frameId, at_ms: atMs, path: rel, existed: false }
}

interface FrameEntry {
  id: string
  at_ms: number
  path: string
  trigger: string
}

/** Append a frame entry to transcript.json frames[] when present, otherwise to
 * a frames.json sidecar that the transcriber merges on the next run. */
function indexFrame(sessionDir: string, entry: FrameEntry): void {
  const transcriptPath = join(sessionDir, 'transcript.json')
  if (existsSync(transcriptPath)) {
    const t = JSON.parse(readFileSync(transcriptPath, 'utf8')) as { frames?: FrameEntry[] }
    t.frames = t.frames ?? []
    if (!t.frames.some((f) => f.id === entry.id)) t.frames.push(entry)
    writeFileSync(transcriptPath, `${JSON.stringify(t, null, 2)}\n`, 'utf8')
    return
  }
  const sidecar = join(sessionDir, 'frames.json')
  const frames: FrameEntry[] = existsSync(sidecar)
    ? (JSON.parse(readFileSync(sidecar, 'utf8')) as FrameEntry[])
    : []
  if (!frames.some((f) => f.id === entry.id)) frames.push(entry)
  writeFileSync(sidecar, `${JSON.stringify(frames, null, 2)}\n`, 'utf8')
}
