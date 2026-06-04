import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { initSeed } from './seed.js'
import { getSession } from './session.js'

const TRANSCRIPT = {
  schema_version: '1.0',
  session_id: 'S001',
  source: 'sessions/S001/source.mp4',
  language: 'es-CO',
  duration_ms: 60000,
  modality: ['audio'],
  speakers: [{ id: 'S2', type: 'participant' }],
  utterances: [
    { id: 'U-0001', speaker_id: 'S2', turn: 1, start_ms: 0, end_ms: 3000, text: 'hola' },
  ],
  silences: [],
  cues: [],
  frames: [
    {
      id: 'FR-001',
      at_ms: 1500,
      trigger: 'silence_after_question',
      path: 'sessions/S001/frames/0001500.jpg',
    },
  ],
}

describe('getSession', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-session-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  function seedWithSession(): string {
    const { path } = initSeed('demo', { cwd: work })
    const sdir = join(path, 'sessions', 'S001')
    mkdirSync(sdir, { recursive: true })
    writeFileSync(join(sdir, 'transcript.json'), JSON.stringify(TRANSCRIPT))
    return path
  }

  it('returns transcript + derived frame index', () => {
    const path = seedWithSession()
    const view = getSession(path, 'S001')
    assert.equal(view.session_id, 'S001')
    assert.equal(view.seed, 'demo')
    assert.equal((view.transcript as { session_id: string }).session_id, 'S001')
    assert.equal(view.frames.length, 1)
    assert.equal(view.frames[0]?.trigger, 'silence_after_question')
    assert.equal(view.frames[0]?.at_ms, 1500)
  })

  it('rejects a path-traversal session id', () => {
    const path = seedWithSession()
    assert.throws(
      () => getSession(path, '../etc/passwd'),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })

  it('errors when the session directory is missing', () => {
    const path = seedWithSession()
    assert.throws(
      () => getSession(path, 'S999'),
      (e: unknown) => e instanceof CompostError && e.code === 'FILE_NOT_FOUND',
    )
  })

  it('errors when the session has no transcript.json yet', () => {
    const path = seedWithSession()
    mkdirSync(join(path, 'sessions', 'S002'), { recursive: true })
    writeFileSync(join(path, 'sessions', 'S002', 'source.mp3'), '')
    assert.throws(
      () => getSession(path, 'S002'),
      (e: unknown) => e instanceof CompostError && e.code === 'FILE_NOT_FOUND',
    )
  })

  it('falls back to on-disk frames when the transcript has no frames[]', () => {
    const { path } = initSeed('demo2', { cwd: work })
    const sdir = join(path, 'sessions', 'S001')
    mkdirSync(join(sdir, 'frames'), { recursive: true })
    const noFrames = { ...TRANSCRIPT }
    // biome-ignore lint/performance/noDelete: test fixture shaping
    delete (noFrames as { frames?: unknown }).frames
    writeFileSync(join(sdir, 'transcript.json'), JSON.stringify(noFrames))
    writeFileSync(join(sdir, 'frames', '0002000.jpg'), '')

    const view = getSession(path, 'S001')
    assert.equal(view.frames.length, 1)
    assert.equal(view.frames[0]?.trigger, 'on-disk')
  })
})
