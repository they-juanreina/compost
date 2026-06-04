import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { createCode, createHighlight, createTheme, endorseArtifact } from './artifacts.js'
import { blame } from './blame.js'
import { initSeed } from './seed.js'

const RESEARCHER = { actorType: 'researcher' as const, actorId: 'juan@example.com' }
const AI = {
  actorType: 'ai' as const,
  actorId: 'claude-code:0.1.0:abc12345',
  model: 'anthropic:claude',
  promptHash: 'f'.repeat(64),
}

describe('createHighlight', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-artifacts-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('writes H-NNN markdown with dual id + artifact_id and emits a create event', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-0002',
      span: [0, 16],
      text: 'No sé si confiar',
      author: RESEARCHER,
    })
    assert.equal(created.id, 'H-001')
    assert.equal(created.artifact_id.length, 64)
    assert.ok(created.path.endsWith('highlights/H-001.md'))

    const md = readFileSync(created.path, 'utf8')
    assert.match(md, /id: H-001/)
    assert.match(md, new RegExp(`artifact_id: ${created.artifact_id}`))
    assert.match(md, /actor_type: researcher/)
    assert.match(md, /No sé si confiar/)

    // blame finds the create event by the SHA artifact_id
    const result = blame(created.artifact_id, { cwd: work, seed: 'demo' })
    assert.equal(result.events.length, 1)
    assert.equal(result.events[0]?.action, 'create')
    assert.equal(result.events[0]?.actor_type, 'researcher')
  })

  it('allocates incrementing ids across calls', () => {
    const { path } = initSeed('demo', { cwd: work })
    const a = createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-1',
      span: [0, 1],
      text: 'a',
      author: RESEARCHER,
    })
    const b = createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-2',
      span: [0, 1],
      text: 'b',
      author: RESEARCHER,
    })
    assert.equal(a.id, 'H-001')
    assert.equal(b.id, 'H-002')
  })

  it('records AI authorship (model + prompt_hash) for --ai creates', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-0002',
      span: [0, 5],
      text: 'hello',
      author: AI,
    })
    const result = blame(created.artifact_id, { cwd: work, seed: 'demo' })
    const evt = result.events[0]
    assert.ok(evt)
    assert.equal(evt.actor_type, 'ai')
    assert.equal(evt.actor_id, 'claude-code:0.1.0:abc12345')
    assert.equal(evt.model, 'anthropic:claude')
    assert.equal(evt.prompt_hash, 'f'.repeat(64))
  })
})

describe('createCode / createTheme', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-artifacts-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('slugifies code name into C-slug id + filename', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createCode(path, {
      name: 'Distrust of Automation',
      definition: 'Doubt about acting on alerts.',
      evidence: ['H-001'],
      author: RESEARCHER,
    })
    assert.equal(created.id, 'C-distrust-of-automation')
    assert.ok(created.path.endsWith('codebook/distrust-of-automation.md'))
    const md = readFileSync(created.path, 'utf8')
    assert.match(md, /evidence: \[H-001\]/)
  })

  it('refuses to overwrite an existing code', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'dup', definition: 'x', author: RESEARCHER })
    assert.throws(
      () => createCode(path, { name: 'dup', definition: 'y', author: RESEARCHER }),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })

  it('creates a theme with a title heading and codes list', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createTheme(path, {
      name: 'Control earns trust',
      summary: 'Trust rises with manual override.',
      codes: ['C-distrust', 'C-override'],
      author: RESEARCHER,
    })
    assert.equal(created.id, 'T-control-earns-trust')
    const md = readFileSync(created.path, 'utf8')
    assert.match(md, /# Control earns trust/)
    assert.match(md, /codes: \[C-distrust, C-override\]/)
  })

  it('rejects a name with no slug-able characters', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.throws(
      () => createCode(path, { name: '!!!', definition: 'x', author: RESEARCHER }),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })
})

describe('endorseArtifact', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-artifacts-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('chains an endorse event onto an AI draft (full blame lineage)', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createCode(path, { name: 'distrust', definition: 'x', author: AI })

    const res = endorseArtifact(path, created.artifact_id, 'juan@example.com')
    assert.equal(res.artifact_id, created.artifact_id)
    assert.equal(res.parent_event_id, created.event_id)

    // blame now shows create(ai) → endorse(researcher)
    const lineage = blame(created.artifact_id, { cwd: work, seed: 'demo' })
    assert.equal(lineage.events.length, 2)
    assert.equal(lineage.events[0]?.action, 'create')
    assert.equal(lineage.events[0]?.actor_type, 'ai')
    assert.equal(lineage.events[1]?.action, 'endorse')
    assert.equal(lineage.events[1]?.actor_type, 'researcher')
    assert.equal(lineage.events[1]?.parent_event, created.event_id)
  })

  it('resolves latest:<kind>=<seed> refs like blame does', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'one', definition: 'x', author: AI })
    const res = endorseArtifact(path, 'latest:code=demo', 'juan@example.com')
    assert.ok(res.endorse_event_id.length > 0)
  })

  it('errors on an unknown ref', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'one', definition: 'x', author: AI })
    assert.throws(
      () => endorseArtifact(path, 'deadbeef', 'juan@example.com'),
      (e: unknown) => e instanceof CompostError && e.code === 'FILE_NOT_FOUND',
    )
  })
})
