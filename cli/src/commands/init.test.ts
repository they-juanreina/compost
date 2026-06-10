import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { initSeed } from '../lib/seed.js'

describe('initSeed', () => {
  let work: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-init-'))
  })

  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('creates the full Seed/<name>/ directory tree and template files', () => {
    const result = initSeed('demo', { cwd: work })
    const seed = result.path
    for (const dir of [
      'plan',
      'sessions',
      'sessions/_inbox',
      'glossary',
      'highlights',
      'codebook',
      'synthesis',
      'exports',
      'legacy',
      '.compost',
      '.compost/logs',
      '.compost/work',
    ]) {
      assert.ok(existsSync(join(seed, dir)), `missing dir: ${dir}`)
    }
    for (const file of ['seed.md', '.compost/AGENTS.md', '.compost/config.toml']) {
      assert.ok(existsSync(join(seed, file)), `missing file: ${file}`)
    }
  })

  it('renders the seed name and timestamp into seed.md frontmatter', () => {
    const now = new Date('2026-06-02T15:00:00Z')
    const result = initSeed('alpha-beta', { cwd: work, now: () => now })
    const seedMd = readFileSync(join(result.path, 'seed.md'), 'utf8')
    assert.match(seedMd, /name: alpha-beta/)
    assert.match(seedMd, /created_at: 2026-06-02T15:00:00\.000Z/)
    assert.match(seedMd, /# alpha-beta/)
  })

  it('writes config.toml with the balanced frame profile and decision defaults', () => {
    const result = initSeed('demo', { cwd: work })
    const cfg = readFileSync(join(result.path, '.compost/config.toml'), 'utf8')
    assert.match(cfg, /profile\s*=\s*"balanced"/)
    assert.match(cfg, /annotation\s*=\s*"off"/, '#72: frame annotation off by default')
    assert.match(cfg, /ai_suggested\s*=\s*true/, '#74: AI-suggested annotations on by default')
    assert.match(cfg, /include_drafts\s*=\s*"marked"/, '#76: drafts marked in exports')
    assert.match(cfg, /storage\s*=\s*"sqlite"/, '#75: local SQLite evals only')
  })

  it('refuses to clobber an existing seed without --force', () => {
    initSeed('demo', { cwd: work })
    assert.throws(() => initSeed('demo', { cwd: work }), CompostError)
  })

  it('overwrites an existing seed with --force', () => {
    initSeed('demo', { cwd: work })
    assert.doesNotThrow(() => initSeed('demo', { cwd: work, force: true }))
  })

  it('rejects names with spaces or special characters', () => {
    assert.throws(() => initSeed('has space', { cwd: work }), CompostError)
    assert.throws(() => initSeed('with/slash', { cwd: work }), CompostError)
    assert.throws(() => initSeed('', { cwd: work }), CompostError)
  })

  it('accepts alphanumeric names with dashes and underscores', () => {
    assert.doesNotThrow(() => initSeed('trust-S023', { cwd: work }))
    assert.doesNotThrow(() => initSeed('alpha_beta_2', { cwd: work }))
  })

  it('reports no warnings from an ordinary working folder', () => {
    const result = initSeed('demo', { cwd: work })
    assert.deepEqual(result.warnings, [])
  })

  it('warns when run from inside a folder named Seeds (nests Seeds/Seeds — #241)', () => {
    const seedsDir = join(work, 'Seeds')
    mkdirSync(seedsDir)
    const result = initSeed('demo', { cwd: seedsDir })
    // behavior is unchanged — the nested tree is still created…
    assert.ok(existsSync(join(seedsDir, 'Seeds', 'demo', 'seed.md')))
    // …but the foot-gun is called out
    assert.equal(result.warnings.length, 1)
    assert.ok(result.warnings[0]?.includes('Seeds/Seeds'), result.warnings[0])
  })
})

describe('initSeed --from-sample', () => {
  it('unpacks the bundled sample corpus', () => {
    const work = mkdtempSync(join(tmpdir(), 'compost-sample-'))
    try {
      const { path } = initSeed('demo', { cwd: work, fromSample: true })
      assert.ok(existsSync(join(path, 'sessions/S001/transcript.json')))
      assert.ok(existsSync(join(path, 'highlights/H-001.md')))
      assert.ok(existsSync(join(path, 'codebook/distrust-of-automation.md')))
      assert.ok(existsSync(join(path, 'synthesis/themes/control-earns-trust.md')))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
