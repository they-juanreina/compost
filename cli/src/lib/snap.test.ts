import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { parseTimestamp, snap } from './snap.js'

let ffmpegAvailable = true
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
} catch {
  ffmpegAvailable = false
}

describe('parseTimestamp', () => {
  it('parses raw ms', () => {
    assert.equal(parseTimestamp('12340'), 12340)
  })
  it('parses mm:ss', () => {
    assert.equal(parseTimestamp('1:30'), 90000)
  })
  it('parses hh:mm:ss', () => {
    assert.equal(parseTimestamp('1:02:03'), (3600 + 123) * 1000)
  })
  it('rejects garbage', () => {
    assert.throws(() => parseTimestamp('abc'), CompostError)
    assert.throws(() => parseTimestamp('1:2:3:4'), CompostError)
  })
})

describe('snap', { skip: !ffmpegAvailable ? 'ffmpeg not on PATH' : false }, () => {
  let work: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-snap-'))
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  function makeSession(ext: string, args: string[]): string {
    const sessionDir = join(work, 'Seeds', 'demo', 'sessions', 'S001')
    mkdirSync(sessionDir, { recursive: true })
    const source = join(sessionDir, `source.${ext}`)
    execFileSync('ffmpeg', ['-y', ...args, source], { stdio: 'ignore' })
    return join(work, 'Seeds', 'demo')
  }

  it('extracts a 640x360 frame at the given ms and indexes it as manual', () => {
    const seed = makeSession('mp4', ['-f', 'lavfi', '-i', 'testsrc=s=320x180:d=4:r=10'])
    const result = snap(seed, 'S001', '0:02')
    assert.equal(result.at_ms, 2000)
    assert.equal(result.frame_id, 'FR-000002000')
    assert.equal(result.existed, false)
    assert.ok(existsSync(join(seed, result.path)))
    // indexed into frames.json sidecar (no transcript yet)
    const sidecar = join(seed, 'sessions/S001/frames.json')
    assert.ok(existsSync(sidecar))
  })

  it('is idempotent — snapping the same ms returns the existing frame id', () => {
    const seed = makeSession('mp4', ['-f', 'lavfi', '-i', 'testsrc=s=320x180:d=4:r=10'])
    const first = snap(seed, 'S001', '1500')
    assert.equal(first.existed, false)
    const second = snap(seed, 'S001', '1500')
    assert.equal(second.existed, true)
    assert.equal(second.frame_id, first.frame_id)
  })

  it('refuses when the source has no video stream', () => {
    const seed = makeSession('mp3', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'])
    assert.throws(() => snap(seed, 'S001', '1000'), CompostError)
  })

  it('errors when the session has no source media', () => {
    mkdirSync(join(work, 'Seeds', 'demo', 'sessions', 'S001'), { recursive: true })
    assert.throws(() => snap(join(work, 'Seeds', 'demo'), 'S001', '1000'), CompostError)
  })
})
