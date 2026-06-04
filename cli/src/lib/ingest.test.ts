import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { EventWriter } from 'compost-provenance'

import { classify, SUPPORTED_EXTENSIONS } from './dispatch.js'
import { ingestPath } from './ingest.js'
import { JobQueue, stateDbPath } from './queue.js'
import { initSeed } from './seed.js'

describe('classify', () => {
  it('routes audio/video to transcribe', () => {
    assert.equal(classify('a.mp3')?.kind, 'transcribe')
    assert.equal(classify('a.mp4')?.kind, 'transcribe')
  })
  it('routes documents/tabular/markdown to legacy-ingest', () => {
    assert.equal(classify('a.pdf')?.kind, 'legacy-ingest')
    assert.equal(classify('a.csv')?.kind, 'legacy-ingest')
    assert.equal(classify('a.md')?.kind, 'legacy-ingest')
  })
  it('returns null for unsupported', () => {
    assert.equal(classify('a.xyz'), null)
  })
  it('exposes the supported set', () => {
    assert.ok(SUPPORTED_EXTENSIONS.includes('.mp3'))
    assert.ok(SUPPORTED_EXTENSIONS.includes('.pdf'))
  })

  // v0.1-03 additions:
  it('classifies .txt as legacy-ingest/markdown (Otter/Zoom exports)', () => {
    const d = classify('Otter-export.txt')
    assert.ok(d)
    assert.equal(d.kind, 'legacy-ingest')
    assert.equal(d.category, 'markdown')
  })
  it('classifies .xlsx as legacy-ingest/tabular (survey data)', () => {
    const d = classify('survey-results.xlsx')
    assert.ok(d)
    assert.equal(d.kind, 'legacy-ingest')
    assert.equal(d.category, 'tabular')
  })
  it('SUPPORTED_EXTENSIONS includes .txt and .xlsx', () => {
    assert.ok(SUPPORTED_EXTENSIONS.includes('.txt'))
    assert.ok(SUPPORTED_EXTENSIONS.includes('.xlsx'))
  })
})

describe('JobQueue', () => {
  it('enqueues, dedupes on (kind, source_path), claims FIFO, completes', () => {
    const q = new JobQueue(':memory:')
    const a = q.enqueue('transcribe', '/x/a.mp3')
    assert.ok(a.inserted)
    const a2 = q.enqueue('transcribe', '/x/a.mp3')
    assert.equal(a2.inserted, false)
    assert.equal(a2.id, a.id)
    q.enqueue('transcribe', '/x/b.mp4')
    const claimed = q.claim()
    assert.equal(claimed?.source_path, '/x/a.mp3')
    assert.equal(claimed?.status, 'running')
    q.complete(claimed!.id)
    assert.equal(q.list('done').length, 1)
    q.close()
  })

  it('requeues on fail until max attempts, then marks failed', () => {
    const q = new JobQueue(':memory:')
    const { id } = q.enqueue('transcribe', '/x/a.mp3')
    for (let i = 0; i < 3; i++) {
      const j = q.claim()
      assert.ok(j)
      q.fail(j.id, 'boom', 3)
    }
    assert.equal(q.list('failed').length, 1)
    assert.equal(id, q.list('failed')[0]?.id)
    q.close()
  })
})

describe('ingestPath', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-ingest-'))
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('enqueues supported files and emits agent create events', () => {
    const { path } = initSeed('demo', { cwd: work })
    const folder = join(work, 'drop')
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'a.mp3'), '')
    writeFileSync(join(folder, 'b.pdf'), '')
    // .zip is intentionally unsupported (.txt joined the classifier in v0.1-03).
    writeFileSync(join(folder, 'archive.zip'), '')

    const result = ingestPath(path, folder)
    assert.equal(result.queued, 2)
    assert.equal(result.unsupported.length, 1)

    // jobs landed in state.sqlite
    const q = new JobQueue(stateDbPath(path))
    assert.equal(q.list('queued').length, 2)
    q.close()

    // agent create events landed in events.sqlite
    const ev = new EventWriter({ dbPath: join(path, '.compost', 'events.sqlite') })
    // @ts-expect-error private db for assertion
    const rows = ev.db.prepare("SELECT * FROM events WHERE actor_type='agent'").all()
    assert.equal(rows.length, 2)
    ev.close()
  })

  it('is resumable — re-running only enqueues new files', () => {
    const { path } = initSeed('demo', { cwd: work })
    const folder = join(work, 'drop')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'a.mp3'), '')
    ingestPath(path, folder)
    writeFileSync(join(folder, 'b.mp4'), '')
    const second = ingestPath(path, folder)
    assert.equal(second.queued, 1) // only b.mp4
    assert.equal(second.skipped, 1) // a.mp3 already queued
  })

  it('ingests a single file', () => {
    const { path } = initSeed('demo', { cwd: work })
    const f = join(work, 'one.wav')
    writeFileSync(f, '')
    const result = ingestPath(path, f)
    assert.equal(result.queued, 1)
    assert.equal(readdirSync(join(path, '.compost')).includes('state.sqlite'), true)
  })
})
