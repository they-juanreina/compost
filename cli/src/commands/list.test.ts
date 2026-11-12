import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createCode } from '../lib/artifacts.js'
import { initSeed } from '../lib/seed.js'
import { renderList } from '../render/human.js'
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

describe('compost list <kind>', () => {
  let work: string
  let prevCwd: string
  let codeId: string

  beforeEach(() => {
    prevCwd = process.cwd()
    work = mkdtempSync(join(tmpdir(), 'compost-list-cmd-'))
    const seed = initSeed('demo', { cwd: work }).path
    codeId = createCode(seed, { name: 'distrust', definition: 'd', author: AI }).id
    process.chdir(work)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(work, { recursive: true, force: true })
  })

  it('emits JSON with the items and the applied state filter', async () => {
    const out = await runCli('list', 'code', '--state', 'draft', '--seed', 'demo')
    assert.equal(out.status, 'ok')
    assert.equal(out.command, 'list')
    assert.equal(out.kind, 'code')
    assert.equal(out.state, 'draft')
    assert.equal(out.count, 1)
    const items = out.items as Array<{ id: string; state: string }>
    assert.equal(items[0]?.id, codeId)
    assert.equal(items[0]?.state, 'draft')
  })

  it('renders a readable table for --human', async () => {
    const out = await runCli('list', 'code')
    const text = renderList(out as never)
    assert.match(text, /^1 code\(s\) — state: draft \+ endorsed/)
    assert.match(text, /draft\s+C-primary\/distrust\s+distrust/)
    assert.match(text, /ai:claude-code:0\.2\.2:abc12345/)
  })
})
