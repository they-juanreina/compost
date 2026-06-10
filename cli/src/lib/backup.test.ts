import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { createHighlight } from './artifacts.js'
import { backupSeed } from './backup.js'
import { initSeed } from './seed.js'

describe('backupSeed', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-backup-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  function seedWithEvent(): string {
    const { path } = initSeed('demo', { cwd: work })
    createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-0001',
      span: [0, 5],
      text: 'hello',
      author: { actorType: 'researcher', actorId: 'juan' },
    })
    return path
  }

  it('throws FILE_NOT_FOUND when the seed has no events.sqlite', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.throws(
      () => backupSeed(path),
      (e) => e instanceof CompostError && e.code === 'FILE_NOT_FOUND',
    )
  })

  it('writes a non-empty ledger copy + PROV-O bundle into exports/', () => {
    const path = seedWithEvent()
    const res = backupSeed(path, { now: () => new Date('2026-06-10T12:00:00Z') })
    assert.equal(res.mode, 'backup')
    assert.ok(res.entities >= 1)
    assert.ok(res.ledger_copy && existsSync(res.ledger_copy))
    assert.ok(res.provenance && existsSync(res.provenance))
    // The PROV-O bundle is real JSON with content.
    const doc = JSON.parse(readFileSync(res.provenance, 'utf8'))
    assert.ok(doc && typeof doc === 'object')
    // Both land under the seed's exports/.
    assert.ok(readdirSync(join(path, 'exports')).length >= 2)
  })

  it('verify mode checks the ledger without writing', () => {
    const path = seedWithEvent()
    const res = backupSeed(path, { verify: true })
    assert.equal(res.mode, 'verify')
    assert.ok(res.entities >= 1)
    assert.equal(res.ledger_copy, undefined)
    // Nothing written to exports/.
    assert.ok(!existsSync(join(path, 'exports')) || readdirSync(join(path, 'exports')).length === 0)
  })
})
