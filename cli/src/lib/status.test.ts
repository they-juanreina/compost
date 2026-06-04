import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { initSeed } from './seed.js'
import { gatherStatus } from './status.js'

describe('gatherStatus', () => {
  let work: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-status-'))
  })

  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('errors clearly when no Seeds/ directory exists', () => {
    assert.throws(() => gatherStatus({ cwd: work }), CompostError)
  })

  it('returns an empty seeds array when Seeds/ is empty', () => {
    mkdirSync(join(work, 'Seeds'))
    const snap = gatherStatus({ cwd: work })
    assert.equal(snap.schema_version, '1.0')
    assert.deepEqual(snap.seeds, [])
  })

  it('counts a fresh seed with zero artifacts', () => {
    initSeed('demo', { cwd: work })
    const snap = gatherStatus({ cwd: work })
    assert.equal(snap.seeds.length, 1)
    const seed = snap.seeds[0]
    assert.ok(seed)
    assert.equal(seed.name, 'demo')
    assert.equal(seed.status, 'planning')
    assert.deepEqual(seed.owners, [])
    assert.deepEqual(seed.counts, {
      sessions: { total: 0, transcribed: 0, queued: 0, inbox: 0 },
      highlights: 0,
      codes: 0,
      themes: 0,
      frames: 0,
      insights: 0,
      legacy_assets: 0,
    })
  })

  it('classifies sessions: inbox / queued / transcribed and counts frames', () => {
    const { path } = initSeed('demo', { cwd: work })
    // _inbox: 2 dropped files
    writeFileSync(join(path, 'sessions/_inbox/raw1.mp3'), '')
    writeFileSync(join(path, 'sessions/_inbox/raw2.mp4'), '')
    // S001: transcribed (transcript.json present) + 3 frames
    const s001 = join(path, 'sessions/S001')
    mkdirSync(s001, { recursive: true })
    writeFileSync(join(s001, 'source.mp4'), '')
    writeFileSync(join(s001, 'transcript.json'), '{}')
    const f001 = join(s001, 'frames')
    mkdirSync(f001)
    writeFileSync(join(f001, '00001000.jpg'), '')
    writeFileSync(join(f001, '00002000.jpg'), '')
    writeFileSync(join(f001, '00003000.png'), '')
    // S002: queued (source but no transcript.json) + 1 frame
    const s002 = join(path, 'sessions/S002')
    mkdirSync(join(s002, 'frames'), { recursive: true })
    writeFileSync(join(s002, 'source.mp3'), '')
    writeFileSync(join(s002, 'frames/00000500.jpg'), '')

    const snap = gatherStatus({ cwd: work })
    const seed = snap.seeds[0]
    assert.ok(seed)
    assert.deepEqual(seed.counts.sessions, {
      total: 2,
      transcribed: 1,
      queued: 1,
      inbox: 2,
    })
    assert.equal(seed.counts.frames, 4)
  })

  it('counts highlights and codes (markdown files in their dirs)', () => {
    const { path } = initSeed('demo', { cwd: work })
    writeFileSync(join(path, 'highlights/H-001.md'), '')
    writeFileSync(join(path, 'highlights/H-002.md'), '')
    writeFileSync(join(path, 'codebook/c-distrust.md'), '')
    // README.md and dotfiles should not count
    writeFileSync(join(path, 'highlights/README.md'), '')
    writeFileSync(join(path, 'highlights/.draft.md'), '')
    const snap = gatherStatus({ cwd: work })
    const seed = snap.seeds[0]
    assert.ok(seed)
    assert.equal(seed.counts.highlights, 2)
    assert.equal(seed.counts.codes, 1)
  })

  it('counts themes and insights under synthesis/', () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'synthesis/themes'), { recursive: true })
    mkdirSync(join(path, 'synthesis/insights'), { recursive: true })
    writeFileSync(join(path, 'synthesis/themes/trust.md'), '')
    writeFileSync(join(path, 'synthesis/themes/automation.md'), '')
    writeFileSync(join(path, 'synthesis/insights/i-001.md'), '')
    const snap = gatherStatus({ cwd: work })
    const seed = snap.seeds[0]
    assert.ok(seed)
    assert.equal(seed.counts.themes, 2)
    assert.equal(seed.counts.insights, 1)
  })

  it('counts legacy assets recursively', () => {
    const { path } = initSeed('demo', { cwd: work })
    writeFileSync(join(path, 'legacy/old-deck.pptx'), '')
    mkdirSync(join(path, 'legacy/reports'), { recursive: true })
    writeFileSync(join(path, 'legacy/reports/Q1.pdf'), '')
    writeFileSync(join(path, 'legacy/reports/Q2.pdf'), '')
    const snap = gatherStatus({ cwd: work })
    const seed = snap.seeds[0]
    assert.ok(seed)
    assert.equal(seed.counts.legacy_assets, 3)
  })

  it('filters to a single seed when --seed is given', () => {
    initSeed('alpha', { cwd: work })
    initSeed('beta', { cwd: work })
    const snap = gatherStatus({ cwd: work, seed: 'alpha' })
    assert.equal(snap.seeds.length, 1)
    const first = snap.seeds[0]
    assert.ok(first)
    assert.equal(first.name, 'alpha')
  })

  it('errors when --seed names a missing seed', () => {
    initSeed('alpha', { cwd: work })
    assert.throws(() => gatherStatus({ cwd: work, seed: 'ghost' }), CompostError)
  })

  it('completes in under 200ms for a freshly-initialized seed', () => {
    initSeed('demo', { cwd: work })
    const start = performance.now()
    gatherStatus({ cwd: work })
    const elapsed = performance.now() - start
    assert.ok(elapsed < 200, `gatherStatus took ${elapsed.toFixed(1)}ms`)
  })

  // v0.1-08 regression: a migrated legacy seed often has non-canonical
  // subdirs under sessions/ (Notes/, Transcripts/, Attachments/, …).
  // They should NOT be counted as sessions; they should surface as warnings.
  it('does not count non-canonical sessions/ subdirs (Notes, Transcripts, …)', () => {
    const { path } = initSeed('legacy', { cwd: work })
    // Carry-over from a legacy 02_Sessions/ migration:
    mkdirSync(join(path, 'sessions/Notes'), { recursive: true })
    mkdirSync(join(path, 'sessions/Transcripts'), { recursive: true })
    mkdirSync(join(path, 'sessions/Attachments'), { recursive: true })
    // A real session (canonical S\d+) alongside the noise:
    const s001 = join(path, 'sessions/S001')
    mkdirSync(s001, { recursive: true })
    writeFileSync(join(s001, 'transcript.json'), '{}')

    const seed = gatherStatus({ cwd: work }).seeds[0]
    assert.ok(seed)
    assert.deepEqual(seed.counts.sessions, {
      total: 1,
      transcribed: 1,
      queued: 0,
      inbox: 0,
    })
    assert.deepEqual(seed.warnings.sort(), [
      'sessions/Attachments: not a canonical session shape (skipped)',
      'sessions/Notes: not a canonical session shape (skipped)',
      'sessions/Transcripts: not a canonical session shape (skipped)',
    ])
  })

  // v0.1-08 regression: a session dir without an S\d+ name but with a
  // source.<ext> file (inbox watcher just dropped it) should still count.
  it('counts a non-S\\d+ session if it has a source.<ext> file', () => {
    const { path } = initSeed('demo', { cwd: work })
    const interview = join(path, 'sessions/mindi-geyer')
    mkdirSync(interview, { recursive: true })
    writeFileSync(join(interview, 'source.docx'), '')

    const seed = gatherStatus({ cwd: work }).seeds[0]
    assert.ok(seed)
    assert.equal(seed.counts.sessions.total, 1)
    assert.equal(seed.counts.sessions.queued, 1)
    assert.deepEqual(seed.warnings, [])
  })

  it('reports an empty warnings array on a clean seed', () => {
    initSeed('clean', { cwd: work })
    const seed = gatherStatus({ cwd: work }).seeds[0]
    assert.ok(seed)
    assert.deepEqual(seed.warnings, [])
  })
})
