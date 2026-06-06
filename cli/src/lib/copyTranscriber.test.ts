import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

// The prepack copy generator that bundles the Python transcriber source into the
// cli tarball (#206). Tested by driving the real script against temp dirs via its
// COPY_TRANSCRIBER_SRC / COPY_TRANSCRIBER_DEST env overrides.
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'copy-transcriber.mjs',
)

function run(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

function write(p: string, body = '') {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}

describe('copy-transcriber.mjs (#206 bundle)', () => {
  let root: string
  let src: string
  let dest: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copy-transcriber-'))
    src = join(root, 'transcriber')
    dest = join(root, 'cli', 'transcriber')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('bundles app/ + pyproject.toml, preserving the package tree', () => {
    write(join(src, 'app', 'transcribe_cli.py'), 'x')
    write(join(src, 'app', 'pipeline.py'), 'x')
    write(join(src, 'app', 'routes', 'transcribe.py'), 'x')
    write(join(src, 'pyproject.toml'), '[project]\n')

    const r = run({ COPY_TRANSCRIBER_SRC: src, COPY_TRANSCRIBER_DEST: dest })
    assert.equal(r.status, 0, r.stderr)
    // The sentinel findRepoTranscriberDir resolves on, plus the provisioning guard.
    assert.ok(existsSync(join(dest, 'app', 'transcribe_cli.py')))
    assert.ok(existsSync(join(dest, 'pyproject.toml')))
    // Subdirectory structure is preserved (python -m app.* needs the full tree).
    assert.ok(existsSync(join(dest, 'app', 'routes', 'transcribe.py')))
  })

  it('excludes __pycache__ and .pyc so the tarball ships no compiled bytecode', () => {
    write(join(src, 'app', 'transcribe_cli.py'), 'x')
    write(join(src, 'app', '__pycache__', 'transcribe_cli.cpython-311.pyc'), 'x')
    write(join(src, 'app', 'stray.pyc'), 'x')
    write(join(src, 'pyproject.toml'), '[project]\n')

    const r = run({ COPY_TRANSCRIBER_SRC: src, COPY_TRANSCRIBER_DEST: dest })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!existsSync(join(dest, 'app', '__pycache__')), '__pycache__ leaked into bundle')
    assert.ok(!existsSync(join(dest, 'app', 'stray.pyc')), '.pyc leaked into bundle')
  })

  it('cleans the destination so a removed source module never lingers', () => {
    write(join(dest, 'app', 'ghost.py'), 'stale')
    write(join(src, 'app', 'transcribe_cli.py'), 'x')
    write(join(src, 'pyproject.toml'), '[project]\n')

    const r = run({ COPY_TRANSCRIBER_SRC: src, COPY_TRANSCRIBER_DEST: dest })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!existsSync(join(dest, 'app', 'ghost.py')), 'stale file survived the rebuild')
  })

  it('keeps an existing bundle when the source is absent (out-of-monorepo build)', () => {
    write(join(dest, 'app', 'transcribe_cli.py'), 'bundled')
    const r = run({ COPY_TRANSCRIBER_SRC: join(root, 'nope'), COPY_TRANSCRIBER_DEST: dest })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(existsSync(join(dest, 'app', 'transcribe_cli.py')))
  })

  it('fails loudly when neither source nor an existing bundle is present', () => {
    const r = run({ COPY_TRANSCRIBER_SRC: join(root, 'nope'), COPY_TRANSCRIBER_DEST: dest })
    assert.equal(r.status, 1)
  })
})
