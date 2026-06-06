import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { JobQueue, stateDbPath } from '../lib/queue.js'
import { initSeed } from '../lib/seed.js'
import { processInbox } from './ingest_watcher.js'

describe('processInbox', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-watcher-'))
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('is a no-op on an empty inbox', () => {
    const { path } = initSeed('demo', { cwd: work })
    const result = processInbox(path)
    assert.deepEqual(result.moved, [])
  })

  it('moves an inbox file to sessions/<sid>/source.<ext> and enqueues', () => {
    const { path } = initSeed('demo', { cwd: work })
    writeFileSync(join(path, 'sessions/_inbox/interview.mp4'), 'x')
    const result = processInbox(path)
    assert.equal(result.moved.length, 1)
    const m = result.moved[0]
    assert.equal(m?.session_id, 'S001')
    assert.ok(existsSync(join(path, 'sessions/S001/source.mp4')))
    assert.ok(!existsSync(join(path, 'sessions/_inbox/interview.mp4')))
    const q = new JobQueue(stateDbPath(path))
    assert.equal(q.list('queued').length, 1)
    q.close()
  })

  it('assigns incrementing session ids across runs', () => {
    const { path } = initSeed('demo', { cwd: work })
    writeFileSync(join(path, 'sessions/_inbox/a.mp3'), 'x')
    processInbox(path)
    writeFileSync(join(path, 'sessions/_inbox/b.mp3'), 'x')
    const r2 = processInbox(path)
    assert.equal(r2.moved[0]?.session_id, 'S002')
  })

  it('leaves unsupported files in the inbox', () => {
    const { path } = initSeed('demo', { cwd: work })
    // .zip stays unsupported in v0.1-03 (.txt joined the classifier).
    writeFileSync(join(path, 'sessions/_inbox/archive.zip'), 'x')
    const result = processInbox(path)
    assert.equal(result.moved.length, 0)
    assert.equal(result.unsupported.length, 1)
    assert.ok(existsSync(join(path, 'sessions/_inbox/archive.zip')))
  })
})
