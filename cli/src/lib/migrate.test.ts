import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { mapLegacyName, migrate, planMigration } from './migrate.js'

describe('mapLegacyName', () => {
  it('strips numeric prefixes and lowercases', () => {
    assert.equal(mapLegacyName('01_Plan'), 'plan')
    assert.equal(mapLegacyName('02_Sessions'), 'sessions')
    assert.equal(mapLegacyName('03_Synthesis'), 'synthesis')
    assert.equal(mapLegacyName('04_Evaluation'), 'evaluation')
    assert.equal(mapLegacyName('10-Misc'), 'misc')
  })

  it('leaves un-prefixed names alone', () => {
    assert.equal(mapLegacyName('plan'), 'plan')
    assert.equal(mapLegacyName('_tools'), '_tools')
  })
})

function makeLegacySeed(root: string, name: string): string {
  const seed = join(root, name)
  for (const dir of ['01_Plan', '02_Sessions', '03_Synthesis', '04_Evaluation']) {
    mkdirSync(join(seed, dir), { recursive: true })
    writeFileSync(join(seed, dir, 'keep.md'), `content of ${dir}`)
  }
  return seed
}

describe('planMigration / migrate', () => {
  let work: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-migrate-'))
  })

  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('plans the four canonical renames without touching the filesystem', () => {
    const seed = makeLegacySeed(work, 'Data Hub')
    const plan = planMigration(seed)
    const pairs = plan.renames.map((r) => `${r.from}->${r.to}`).sort()
    assert.deepEqual(pairs, [
      '01_Plan->plan',
      '02_Sessions->sessions',
      '03_Synthesis->synthesis',
      '04_Evaluation->evaluation',
    ])
    // dry-run is read-only: legacy dirs still present
    assert.ok(existsSync(join(seed, '01_Plan')))
    assert.equal(plan.applied ?? false, false)
  })

  it('applies renames and preserves file contents', () => {
    const seed = makeLegacySeed(work, 'Data Hub')
    const result = migrate(seed, { apply: true })
    assert.ok(result.applied)
    assert.ok(existsSync(join(seed, 'plan/keep.md')))
    assert.ok(existsSync(join(seed, 'sessions/keep.md')))
    assert.ok(existsSync(join(seed, 'synthesis/keep.md')))
    assert.ok(existsSync(join(seed, 'evaluation/keep.md')))
    assert.ok(!existsSync(join(seed, '01_Plan')))
  })

  it('scaffolds .compost/, config.toml, AGENTS.md, and missing dirs', () => {
    const seed = makeLegacySeed(work, 'Data Hub')
    migrate(seed, { apply: true })
    assert.ok(existsSync(join(seed, '.compost/config.toml')))
    assert.ok(existsSync(join(seed, '.compost/AGENTS.md')))
    assert.ok(existsSync(join(seed, 'glossary')))
    assert.ok(existsSync(join(seed, 'highlights')))
    assert.ok(existsSync(join(seed, 'codebook')))
    assert.ok(existsSync(join(seed, 'sessions/_inbox')))
  })

  it('preserves an existing seed.md and writes one when missing', () => {
    const seed = makeLegacySeed(work, 'Data Hub')
    writeFileSync(join(seed, 'seed.md'), 'EXISTING SEED DOC')
    migrate(seed, { apply: true })
    assert.equal(readFileSync(join(seed, 'seed.md'), 'utf8'), 'EXISTING SEED DOC')

    const seed2 = makeLegacySeed(work, 'No Doc')
    migrate(seed2, { apply: true })
    assert.ok(existsSync(join(seed2, 'seed.md')))
  })

  it('is idempotent — a second apply is a no-op', () => {
    const seed = makeLegacySeed(work, 'Data Hub')
    migrate(seed, { apply: true })
    const plan2 = planMigration(seed)
    assert.equal(plan2.renames.length, 0)
    assert.ok(plan2.already_migrated)
    // second apply throws nothing and changes nothing structurally
    assert.doesNotThrow(() => migrate(seed, { apply: true }))
  })

  it('refuses to overwrite an existing target dir', () => {
    const seed = makeLegacySeed(work, 'Conflict')
    mkdirSync(join(seed, 'plan')) // collides with 01_Plan -> plan
    assert.throws(() => migrate(seed, { apply: true }), CompostError)
  })

  it('errors on a non-existent path', () => {
    assert.throws(() => planMigration(join(work, 'ghost')), CompostError)
  })

  it('leaves un-prefixed dirs (e.g. _tools) in place', () => {
    const seed = makeLegacySeed(work, 'With Tools')
    mkdirSync(join(seed, '_tools'))
    writeFileSync(join(seed, '_tools', 't.md'), 'tool')
    migrate(seed, { apply: true })
    assert.ok(existsSync(join(seed, '_tools/t.md')))
  })
})
