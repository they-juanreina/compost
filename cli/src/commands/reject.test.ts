import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createCode } from '../lib/artifacts.js'
import { blame } from '../lib/blame.js'
import { initSeed } from '../lib/seed.js'
import { buildProgram } from '../router.js'

const AI = {
  actorType: 'ai' as const,
  actorId: 'claude-code:0.2.2:abc12345',
  model: 'anthropic:claude',
  promptHash: 'f'.repeat(64),
}

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

describe('compost reject (ADR 0007 P1)', () => {
  let work: string
  let seed: string
  let prevCwd: string
  let codePath: string
  let codeId: string

  beforeEach(() => {
    prevCwd = process.cwd()
    work = mkdtempSync(join(tmpdir(), 'compost-reject-'))
    seed = initSeed('demo', { cwd: work }).path
    const created = createCode(seed, { name: 'distrust', definition: 'd', author: AI })
    codePath = created.path
    codeId = created.id
    process.chdir(work)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(work, { recursive: true, force: true })
  })

  it('archives (never deletes) and records a researcher reject event', async () => {
    const out = await runCli('reject', codeId, '--researcher', 'reviewer@example.com')
    assert.equal(out.status, 'ok')
    assert.equal(out.command, 'reject')
    assert.equal(out.researcher, 'reviewer@example.com')
    assert.equal(typeof out.reject_event_id, 'string')
    assert.equal(typeof out.parent_event_id, 'string')
    assert.equal((out.artifact_id as string).length, 64)

    assert.ok(existsSync(codePath), 'the markdown is kept — reject archives, never deletes')
    const lineage = blame(out.artifact_id as string, { cwd: work, seed: 'demo' })
    const last = lineage.events[lineage.events.length - 1]
    assert.equal(last?.action, 'reject')
    assert.equal(last?.actor_type, 'researcher')
    assert.equal(last?.actor_id, 'reviewer@example.com')
  })

  it('a second reject by the same researcher is an idempotent no-op', async () => {
    const first = await runCli('reject', codeId, '--researcher', 'reviewer@example.com')
    const second = await runCli('reject', codeId, '--researcher', 'reviewer@example.com')
    assert.equal(second.status, 'already_rejected')
    assert.equal(second.reject_event_id, first.reject_event_id)
  })

  it('accepts the same refs as endorse: a SHA prefix and --seed', async () => {
    const sha = (await runCli('blame', codeId)) as { events?: { artifact_id: string }[] }
    const prefix = (sha.events?.[0]?.artifact_id ?? '').slice(0, 12)
    const out = await runCli('reject', prefix, '--seed', 'demo', '--researcher', 'r@example.com')
    assert.equal(out.status, 'ok')
  })
})
