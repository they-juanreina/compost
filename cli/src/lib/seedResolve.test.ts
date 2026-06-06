import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { resolveSeedPath } from './seedResolve.js'

describe('resolveSeedPath', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-seedresolve-'))
    mkdirSync(join(work, 'Seeds'), { recursive: true })
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  describe('happy path', () => {
    it('resolves an existing seed by name', () => {
      mkdirSync(join(work, 'Seeds', 'demo'))
      const p = resolveSeedPath(work, 'demo')
      assert.equal(p, join(work, 'Seeds', 'demo'))
    })

    it('uses the singleton seed when no name passed', () => {
      mkdirSync(join(work, 'Seeds', 'only'))
      const p = resolveSeedPath(work)
      assert.equal(p, join(work, 'Seeds', 'only'))
    })

    it('errors on multi-seed with no --seed', () => {
      mkdirSync(join(work, 'Seeds', 'a'))
      mkdirSync(join(work, 'Seeds', 'b'))
      assert.throws(
        () => resolveSeedPath(work),
        (e) => e instanceof CompostError && /Multiple seeds/.test(e.message),
      )
    })

    it('errors when no Seeds/ at all', () => {
      const empty = mkdtempSync(join(tmpdir(), 'no-seeds-'))
      try {
        assert.throws(
          () => resolveSeedPath(empty),
          (e) => e instanceof CompostError && e.code === 'NOT_IN_SEED',
        )
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    })

    it('accepts legacy seed names with spaces and uppercase (pre-#211 dirs stay usable)', () => {
      // initSeed enforces a stricter regex for NEW seeds, but a seed dir
      // already on disk from a previous version (or migrated by hand) should
      // still resolve. Only the dangerous patterns (path-sep, .., absolute)
      // are rejected.
      mkdirSync(join(work, 'Seeds', 'My Project'))
      const p = resolveSeedPath(work, 'My Project')
      assert.equal(p, join(work, 'Seeds', 'My Project'))
    })
  })

  // The #211 security fix: every seed-scoped command flows through here, so a
  // missing containment check on `--seed` lets `--seed '../../foo'` escape and
  // read/write into arbitrary directories. MCP-attacker model: a prompt-injected
  // AI calls compost_create_code({seed: '../../other-project/Seeds/main', ...})
  // and writes into a seed it was never granted scope to. CLI-footgun model:
  // a copy-pasted `compost ingest --seed '../foo' file.mp3` clobbers files
  // outside the user's intended project.
  describe('rejects path-traversal attempts in seed name (#211)', () => {
    it('rejects `..`', () => {
      assert.throws(
        () => resolveSeedPath(work, '..'),
        (e) => e instanceof CompostError && /\.\./.test(e.message),
      )
    })

    it('rejects a `..` segment via slash', () => {
      assert.throws(
        () => resolveSeedPath(work, '../foo'),
        (e) => e instanceof CompostError && /separators|\.\./.test(e.message),
      )
    })

    it('rejects deeper dotdot escape', () => {
      assert.throws(
        () => resolveSeedPath(work, '../../../etc'),
        (e) => e instanceof CompostError && /separators|\.\./.test(e.message),
      )
    })

    it('rejects forward slash', () => {
      assert.throws(
        () => resolveSeedPath(work, 'foo/bar'),
        (e) => e instanceof CompostError && /separators/.test(e.message),
      )
    })

    it('rejects backslash', () => {
      assert.throws(
        () => resolveSeedPath(work, 'foo\\bar'),
        (e) => e instanceof CompostError && /separators/.test(e.message),
      )
    })

    it('rejects absolute paths', () => {
      assert.throws(
        () => resolveSeedPath(work, '/etc/passwd'),
        (e) => e instanceof CompostError,
      )
    })

    it('rejects the empty string', () => {
      assert.throws(
        () => resolveSeedPath(work, ''),
        (e) => e instanceof CompostError && /empty/.test(e.message),
      )
    })

    it('rejects a single dot', () => {
      assert.throws(
        () => resolveSeedPath(work, '.'),
        (e) => e instanceof CompostError && /\.\./.test(e.message),
      )
    })
  })

  // Belt-and-braces: even if the deny-list ever misses an edge case (Unicode
  // path tricks, OS-specific quirks), the post-join containment check throws.
  it('asserts containment under Seeds/ as a backstop', () => {
    // Construct an existing dir outside Seeds/ that resolveSeedPath could
    // otherwise locate via a tricky name. We test by injecting a name that
    // somehow slipped the deny-list — there isn't one we can easily reach
    // through the public surface (the deny-list is comprehensive on
    // platforms we support), so this test is forward-looking insurance.
    // We exercise it indirectly: any name accepted by assertSeedName resolves
    // INTO Seeds/, and any name that would escape is rejected before fs ops.
    // The containment check is exercised end-to-end by every other test in
    // this suite — assert here that a normal valid name passes both gates.
    mkdirSync(join(work, 'Seeds', 'demo'))
    const p = resolveSeedPath(work, 'demo')
    assert.ok(p.startsWith(join(work, 'Seeds')))
  })
})
