import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { EventWriter } from '@they-juanreina/compost-provenance'

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

  // Pre-fix, walk() used statSync (follows symlinks) — a tarball with a
  // symlinked subdir would silently traverse into ~/.ssh, /var/log, etc.,
  // queueing arbitrary files under the destination for ingest (#212).
  describe('symlink safety (#212)', () => {
    it('does not follow symlinked subdirectories', () => {
      const { path } = initSeed('demo', { cwd: work })
      const folder = join(work, 'drop')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'real.mp3'), '')

      // External "escape" dir holding what would be exfil-shaped content if
      // walked. We point a symlink at it from inside the ingest target.
      const elsewhere = join(work, 'elsewhere')
      mkdirSync(elsewhere)
      writeFileSync(join(elsewhere, 'secret.wav'), '')
      symlinkSync(elsewhere, join(folder, 'escape'))

      const result = ingestPath(path, folder)
      // Only the real file inside the ingest target should be queued.
      assert.equal(result.queued, 1)
      assert.equal(result.items[0]?.path.endsWith('real.mp3'), true)
      // The symlink is reported separately, not silently dropped.
      assert.deepEqual(result.symlinks_skipped, [join(folder, 'escape')])
    })

    it('skips symlinked files within the target (does not queue them)', () => {
      const { path } = initSeed('demo', { cwd: work })
      const folder = join(work, 'drop')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'real.mp3'), '')

      const elsewhereFile = join(work, 'outside.mp3')
      writeFileSync(elsewhereFile, '')
      symlinkSync(elsewhereFile, join(folder, 'fake.mp3'))

      const result = ingestPath(path, folder)
      assert.equal(result.queued, 1)
      assert.equal(result.items[0]?.path.endsWith('real.mp3'), true)
      assert.deepEqual(result.symlinks_skipped, [join(folder, 'fake.mp3')])
    })

    it('still accepts the top-level target being an explicit file path', () => {
      // The user can still type `compost ingest some.wav` — only the walk
      // refuses to follow symlinks discovered DURING traversal.
      const { path } = initSeed('demo', { cwd: work })
      const f = join(work, 'one.wav')
      writeFileSync(f, '')
      const result = ingestPath(path, f)
      assert.equal(result.queued, 1)
      assert.equal(result.symlinks_skipped, undefined)
    })
  })
})
