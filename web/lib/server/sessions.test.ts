import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '@they-juanreina/compost-cli/engine'

import { ApiError } from './http.js'
import { getSessionForSeed, listSessionsForSeed, readFrame } from './sessions.js'

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'compost-web-sessions-'))
  const sdir = join(work, 'Seeds', 'demo', 'sessions', 'S001')
  mkdirSync(join(sdir, 'frames'), { recursive: true })
  writeFileSync(
    join(sdir, 'transcript.json'),
    JSON.stringify({
      schema_version: '1.0',
      session_id: 'S001',
      duration_ms: 5000,
      utterances: [{ id: 'U-1', text: 'hi' }],
      frames: [
        {
          id: 'FR-001',
          at_ms: 1000,
          trigger: 'manual',
          path: 'sessions/S001/frames/000001000.jpg',
        },
      ],
    }),
  )
  writeFileSync(join(sdir, 'frames', '000001000.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  // a queued session with no transcript yet
  mkdirSync(join(work, 'Seeds', 'demo', 'sessions', 'S002'), { recursive: true })
  process.env.COMPOST_ROOT = work
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
  delete process.env.COMPOST_ROOT
})

describe('listSessionsForSeed', () => {
  it('lists sessions with counts and marks not-yet-transcribed ones', () => {
    const list = listSessionsForSeed('demo')
    assert.equal(list.length, 2)
    const s1 = list.find((s) => s.session_id === 'S001')
    assert.deepEqual(s1, {
      session_id: 'S001',
      has_transcript: true,
      utterance_count: 1,
      frame_count: 1,
      duration_ms: 5000,
    })
    assert.equal(list.find((s) => s.session_id === 'S002')?.has_transcript, false)
  })
})

describe('getSessionForSeed', () => {
  it('returns the transcript + derived frame index', () => {
    const view = getSessionForSeed('demo', 'S001')
    assert.equal(view.frames.length, 1)
    assert.equal(view.frames[0]?.id, 'FR-001')
  })

  it('throws for a missing session', () => {
    assert.throws(
      () => getSessionForSeed('demo', 'S999'),
      (e) => e instanceof CompostError,
    )
  })
})

describe('readFrame', () => {
  it('serves an existing frame as image/jpeg', () => {
    const { body, contentType } = readFrame('demo', 'S001', 'FR-001')
    assert.equal(contentType, 'image/jpeg')
    assert.ok(body.length > 0)
  })

  it('rejects a traversal-shaped id', () => {
    assert.throws(
      () => readFrame('demo', 'S001', '../../secret'),
      (e) => e instanceof ApiError && e.code === 'INVALID_INPUT',
    )
  })

  it('404s an unknown frame id', () => {
    assert.throws(
      () => readFrame('demo', 'S001', 'FR-999'),
      (e) => e instanceof ApiError && e.code === 'NOT_FOUND',
    )
  })
})
