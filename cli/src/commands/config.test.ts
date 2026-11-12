import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { initSeed } from '../lib/seed.js'
import { buildProgram } from '../router.js'

async function runCli(...argv: string[]): Promise<Record<string, unknown>> {
  const chunks: string[] = []
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((s: string) => {
    chunks.push(String(s))
    return true
  }) as typeof process.stdout.write
  try {
    await buildProgram().parseAsync(['node', 'compost', '--json', ...argv])
  } finally {
    process.stdout.write = realWrite
  }
  return JSON.parse(chunks.join('')) as Record<string, unknown>
}

describe('compost config --global + identity (ADR 0008)', () => {
  let work: string
  let prevCwd: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    prevCwd = process.cwd()
    work = mkdtempSync(join(tmpdir(), 'compost-config-'))
    initSeed('demo', { cwd: work })
    for (const k of ['COMPOST_HOME', 'COMPOST_USER']) saved[k] = process.env[k]
    process.env.COMPOST_HOME = join(work, 'home')
    delete process.env.COMPOST_USER
    process.chdir(work)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(work, { recursive: true, force: true })
  })

  it('`config set user.email … --global` writes the per-user file, not the seed', async () => {
    const out = await runCli('config', 'set', 'user.email', 'juan@example.com', '--global')
    assert.equal(out.scope, 'global')
    assert.equal(out.path, join(work, 'home', 'config.toml'))
    assert.match(
      readFileSync(join(work, 'home', 'config.toml'), 'utf8'),
      /email = "juan@example.com"/,
    )
    assert.doesNotMatch(
      readFileSync(join(work, 'Seeds', 'demo', '.compost', 'config.toml'), 'utf8'),
      /juan@example.com/,
    )
    const got = await runCli('config', 'get', 'user.email', '--global')
    assert.equal(got.value, 'juan@example.com')
  })

  it('without --global, `config set` targets the seed and wins over the global identity', async () => {
    await runCli('config', 'set', 'user.email', 'global@example.com', '--global')
    const out = await runCli('config', 'set', 'user.email', 'seed@example.com')
    assert.equal(out.scope, 'seed')
    const show = await runCli('config', 'show')
    const identity = show.identity as { id: string; source: string }
    assert.equal(identity.id, 'seed@example.com')
    assert.equal(identity.source, 'seed_config')
  })

  it('`config show` reports the resolved identity and its source', async () => {
    process.env.COMPOST_USER = 'env@example.com'
    const show = await runCli('config', 'show')
    assert.deepEqual(
      { ...(show.identity as object), name: undefined },
      { id: 'env@example.com', name: undefined, source: 'env', source_detail: '$COMPOST_USER' },
    )
    assert.equal(show.identity_fix, undefined)
  })
})
