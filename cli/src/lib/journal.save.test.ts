import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { agentsPath, parseVersions, readJournal, saveJournal } from './journal.js'

let work: string
let seed: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'compost-journal-'))
  seed = join(work, 'Seeds', 'demo')
  mkdirSync(seed, { recursive: true })
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

describe('saveJournal (gitless)', () => {
  it('creates AGENTS.md and round-trips the draft', () => {
    const res = saveJournal(seed, 'first prompt', '2026-06-07T00:00:00Z')
    assert.equal(res.mode, 'append')
    const { draft, versions } = parseVersions(readJournal(seed))
    assert.equal(draft, 'first prompt')
    assert.equal(versions.length, 0) // nothing to snapshot the first time
  })

  it('snapshots the prior draft as a timestamped version, newest first', () => {
    saveJournal(seed, 'v1 prompt', '2026-06-07T00:00:00Z')
    const res = saveJournal(seed, 'v2 prompt', '2026-06-07T01:00:00Z')
    assert.equal(res.mode, 'append')
    assert.equal(res.versions, 1)

    const { draft, versions } = parseVersions(readJournal(seed))
    assert.equal(draft, 'v2 prompt')
    assert.equal(versions.length, 1)
    assert.equal(versions[0]?.ts, '2026-06-07T01:00:00Z')
    assert.equal(versions[0]?.body, 'v1 prompt')
  })
})

describe('saveJournal (git)', () => {
  function git(...args: string[]) {
    return spawnSync('git', ['-C', work, ...args], { encoding: 'utf8' })
  }
  beforeEach(() => {
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
  })

  it('commits AGENTS.md instead of appending an inline version', () => {
    saveJournal(seed, 'v1 prompt', '2026-06-07T00:00:00Z')
    const res = saveJournal(seed, 'v2 prompt', '2026-06-07T01:00:00Z')
    assert.equal(res.mode, 'git')

    // The working draft is the latest; no inline snapshot is added in git mode.
    const { draft, versions } = parseVersions(readJournal(seed))
    assert.equal(draft, 'v2 prompt')
    assert.equal(versions.length, 0)

    // Two commits touched AGENTS.md.
    const log = spawnSync('git', ['-C', work, 'log', '--oneline', '--', agentsPath(seed)], {
      encoding: 'utf8',
    })
    assert.equal(log.stdout.trim().split('\n').length, 2)
  })

  it('persists the draft to disk', () => {
    saveJournal(seed, 'committed prompt', '2026-06-07T00:00:00Z')
    assert.match(readFileSync(agentsPath(seed), 'utf8'), /committed prompt/)
  })
})
