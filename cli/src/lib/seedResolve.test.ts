import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { CompostError } from '../errors.js'
import { blame } from './blame.js'
import { initSeed } from './seed.js'
import {
  requireSeedsRoot,
  resolveSeedPath,
  resolveSeedsRoot,
  SEEDS_DIR_ENV,
  seedPathUnder,
} from './seedResolve.js'
import { gatherStatus } from './status.js'

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

// ---------------------------------------------------------------------------
// Explicit Seeds root (#334): $COMPOST_SEEDS_DIR → global seeds.dir → ./Seeds
// ---------------------------------------------------------------------------

describe('resolveSeedsRoot / requireSeedsRoot', () => {
  let work: string
  let home: string
  let envRoot: string
  let cfgRoot: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-seedsroot-'))
    home = join(work, 'home')
    envRoot = join(work, 'from-env', 'Seeds')
    cfgRoot = join(work, 'from-config', 'Seeds')
    mkdirSync(home, { recursive: true })
    mkdirSync(join(work, 'cwd', 'Seeds'), { recursive: true })
    mkdirSync(envRoot, { recursive: true })
    mkdirSync(cfgRoot, { recursive: true })
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  const cwd = () => join(work, 'cwd')
  const writeGlobal = (dirToml: string) =>
    writeFileSync(join(home, 'config.toml'), `[seeds]\ndir = ${dirToml}\n`)

  it('defaults to <cwd>/Seeds when nothing is set', () => {
    const r = resolveSeedsRoot({ cwd: cwd(), env: { COMPOST_HOME: home } })
    assert.equal(r.root, join(cwd(), 'Seeds'))
    assert.equal(r.source, 'cwd')
  })

  it('global seeds.dir beats cwd', () => {
    writeGlobal(JSON.stringify(cfgRoot))
    const r = resolveSeedsRoot({ cwd: cwd(), env: { COMPOST_HOME: home } })
    assert.equal(r.root, cfgRoot)
    assert.equal(r.source, 'global_config')
    assert.match(r.source_detail, /seeds\.dir in .*config\.toml/)
  })

  it('$COMPOST_SEEDS_DIR beats global seeds.dir and cwd', () => {
    writeGlobal(JSON.stringify(cfgRoot))
    const r = resolveSeedsRoot({
      cwd: cwd(),
      env: { COMPOST_HOME: home, [SEEDS_DIR_ENV]: envRoot },
    })
    assert.equal(r.root, envRoot)
    assert.equal(r.source, 'env')
  })

  it('a blank $COMPOST_SEEDS_DIR counts as unset', () => {
    const r = resolveSeedsRoot({ cwd: cwd(), env: { COMPOST_HOME: home, [SEEDS_DIR_ENV]: '  ' } })
    assert.equal(r.source, 'cwd')
  })

  it('rejects a relative $COMPOST_SEEDS_DIR with a fix', () => {
    assert.throws(
      () => resolveSeedsRoot({ cwd: cwd(), env: { COMPOST_HOME: home, [SEEDS_DIR_ENV]: 'Seeds' } }),
      (err: unknown) =>
        err instanceof CompostError &&
        err.code === 'CONFIG_ERROR' &&
        /COMPOST_SEEDS_DIR must be an absolute path/.test(err.message) &&
        /export COMPOST_SEEDS_DIR=\/absolute\/path\/to\/Seeds/.test(err.message),
    )
  })

  it('rejects a relative or ~ global seeds.dir with a fix', () => {
    for (const bad of ['../Seeds', '~/Seeds']) {
      writeGlobal(JSON.stringify(bad))
      assert.throws(
        () => resolveSeedsRoot({ cwd: cwd(), env: { COMPOST_HOME: home } }),
        (err: unknown) =>
          err instanceof CompostError &&
          err.code === 'CONFIG_ERROR' &&
          /seeds\.dir in .* must be an absolute path/.test(err.message) &&
          /compost config set seeds\.dir \/absolute\/path\/to\/Seeds --global/.test(err.message),
      )
    }
  })

  it('rejects a non-string global seeds.dir', () => {
    writeGlobal('42')
    assert.throws(
      () => resolveSeedsRoot({ cwd: cwd(), env: { COMPOST_HOME: home } }),
      (err: unknown) => err instanceof CompostError && err.code === 'CONFIG_ERROR',
    )
  })

  it('a missing root names the source that supplied it', () => {
    const gone = join(work, 'nowhere', 'Seeds')
    assert.throws(
      () => requireSeedsRoot({ cwd: cwd(), env: { COMPOST_HOME: home, [SEEDS_DIR_ENV]: gone } }),
      (err: unknown) =>
        err instanceof CompostError &&
        err.code === 'NOT_IN_SEED' &&
        err.message.includes(gone) &&
        err.message.includes('$COMPOST_SEEDS_DIR'),
    )
    writeGlobal(JSON.stringify(gone))
    assert.throws(
      () => requireSeedsRoot({ cwd: cwd(), env: { COMPOST_HOME: home } }),
      (err: unknown) =>
        err instanceof CompostError &&
        err.message.includes(gone) &&
        err.message.includes('seeds.dir in'),
    )
    rmSync(join(home, 'config.toml'))
    assert.throws(
      () => requireSeedsRoot({ cwd: join(work, 'empty'), env: { COMPOST_HOME: home } }),
      (err: unknown) =>
        err instanceof CompostError &&
        err.message.includes('./Seeds under the working directory') &&
        err.message.includes('compost init'),
    )
  })

  it('resolveSeedPath resolves under the override root and keeps #211 containment', () => {
    mkdirSync(join(envRoot, 'demo'))
    const env = { COMPOST_HOME: home, [SEEDS_DIR_ENV]: envRoot }
    assert.equal(resolveSeedPath(join(work, 'empty'), 'demo', env), join(envRoot, 'demo'))
    assert.equal(resolveSeedPath(join(work, 'empty'), undefined, env), join(envRoot, 'demo'))
    // A sibling of the override root is still out of bounds.
    mkdirSync(join(work, 'from-env', 'outside'))
    for (const escapee of ['../outside', '..', join(work, 'from-env', 'outside')]) {
      assert.throws(
        () => resolveSeedPath(join(work, 'empty'), escapee, env),
        (err: unknown) => err instanceof CompostError && err.code === 'INVALID_INPUT',
      )
    }
  })

  it('seedPathUnder refuses an escape from the resolved root', () => {
    assert.throws(() => seedPathUnder(envRoot, '../x'), CompostError)
    assert.equal(seedPathUnder(envRoot, 'demo'), join(envRoot, 'demo'))
  })
})

// status, blame and init resolve their seeds through the same override. The
// cwd has no Seeds/ at all — exactly the desktop-app MCP server's situation.
describe('status, blame and init honour the Seeds-root override', () => {
  let work: string
  let root: string
  let home: string
  const artifactId = 'ab'.repeat(32)
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-seedsroot-cmds-'))
    root = join(work, 'elsewhere', 'Seeds')
    home = join(work, 'home')
    mkdirSync(root, { recursive: true })
    mkdirSync(home, { recursive: true })
    mkdirSync(join(work, 'cwd'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  const sources: Array<[string, () => NodeJS.ProcessEnv]> = [
    ['$COMPOST_SEEDS_DIR', () => ({ COMPOST_HOME: home, [SEEDS_DIR_ENV]: root })],
    [
      'global seeds.dir',
      () => {
        writeFileSync(join(home, 'config.toml'), `[seeds]\ndir = ${JSON.stringify(root)}\n`)
        return { COMPOST_HOME: home }
      },
    ],
  ]

  for (const [label, makeEnv] of sources) {
    it(`init + status via ${label}`, () => {
      const env = makeEnv()
      const init = initSeed('demo', { cwd: join(work, 'cwd'), env })
      assert.equal(init.path, join(root, 'demo'))
      const snap = gatherStatus({ cwd: join(work, 'cwd'), env })
      assert.equal(snap.root, root)
      assert.deepEqual(
        snap.seeds.map((s) => s.name),
        ['demo'],
      )
    })

    it(`blame via ${label}`, () => {
      const env = makeEnv()
      const { path } = initSeed('demo', { cwd: join(work, 'cwd'), env })
      const db = new Database(join(path, '.compost', 'events.sqlite'))
      db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, ts TEXT NOT NULL, artifact_kind TEXT NOT NULL,
        artifact_id TEXT NOT NULL, action TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
        agent_name TEXT, agent_version TEXT, prompt_hash TEXT, model TEXT, payload TEXT NOT NULL,
        parent_event TEXT, batch_id TEXT)`)
      db.prepare(
        `INSERT INTO events VALUES ('01JM9NPC000000000000000001', '2026-11-12T00:00:00.000Z', 'highlight', ?, 'create', 'researcher', 'juan', NULL, NULL, NULL, NULL, '{}', NULL, NULL)`,
      ).run(artifactId)
      db.close()
      const result = blame(artifactId.slice(0, 12), { cwd: join(work, 'cwd'), env })
      assert.equal(result.seed, 'demo')
      assert.equal(result.events.length, 1)
    })
  }

  it('init refuses an explicit root that does not exist (no stray scaffold)', () => {
    const gone = join(work, 'typo', 'Seeds')
    assert.throws(
      () =>
        initSeed('demo', {
          cwd: join(work, 'cwd'),
          env: { COMPOST_HOME: home, [SEEDS_DIR_ENV]: gone },
        }),
      (err: unknown) => err instanceof CompostError && err.message.includes('$COMPOST_SEEDS_DIR'),
    )
    assert.equal(existsSync(gone), false)
  })
})
