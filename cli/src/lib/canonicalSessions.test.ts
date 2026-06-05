import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  CANONICAL_SESSION_ID_RE,
  isCanonicalSession,
  listCanonicalSessionIds,
} from './canonicalSessions.js'

// The shared predicate that keeps `status` and `saturate` from disagreeing on
// the session set (#166). Three forms of "canonical": S\d+ name, transcript.json
// present, or source.<ext> present.
describe('canonical session predicate (#166)', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-canonsess-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('CANONICAL_SESSION_ID_RE matches S001, S012, S999 but not arbitrary names', () => {
    assert.ok(CANONICAL_SESSION_ID_RE.test('S001'))
    assert.ok(CANONICAL_SESSION_ID_RE.test('S12345'))
    assert.ok(!CANONICAL_SESSION_ID_RE.test('Attachments'))
    assert.ok(!CANONICAL_SESSION_ID_RE.test('Transcripts'))
    assert.ok(!CANONICAL_SESSION_ID_RE.test('s001')) // case-sensitive
  })

  it('treats an S\\d+ folder as canonical even when empty', () => {
    const dir = join(work, 'S001')
    mkdirSync(dir)
    assert.ok(isCanonicalSession(dir, 'S001'))
  })

  it('treats any folder with transcript.json as canonical (#166)', () => {
    const dir = join(work, 'Pilot-Interview')
    mkdirSync(dir)
    writeFileSync(join(dir, 'transcript.json'), '{}')
    assert.ok(isCanonicalSession(dir, 'Pilot-Interview'))
  })

  it('treats any folder with source.<ext> as canonical (queued, pre-transcribe)', () => {
    const dir = join(work, 'incoming')
    mkdirSync(dir)
    writeFileSync(join(dir, 'source.mp4'), '')
    assert.ok(isCanonicalSession(dir, 'incoming'))
  })

  it('rejects legacy carry-over folders that have neither marker', () => {
    const dir = join(work, 'Attachments')
    mkdirSync(dir)
    writeFileSync(join(dir, 'misc.pdf'), '')
    assert.ok(!isCanonicalSession(dir, 'Attachments'))
  })

  it('listCanonicalSessionIds filters _inbox, dotfiles, files, and non-canonical dirs', () => {
    mkdirSync(join(work, 'S001'))
    mkdirSync(join(work, 'S002'))
    mkdirSync(join(work, '_inbox'))
    mkdirSync(join(work, '.hidden'))
    mkdirSync(join(work, 'Attachments')) // legacy carry-over, no markers
    writeFileSync(join(work, 'README.md'), '')

    const ids = listCanonicalSessionIds(work)
    assert.deepEqual(ids.sort(), ['S001', 'S002'])
  })

  it('returns [] when the sessions/ dir does not exist (fresh seed)', () => {
    assert.deepEqual(listCanonicalSessionIds(join(work, 'never-created')), [])
  })
})
