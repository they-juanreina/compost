import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  createCode,
  createHighlight,
  endorseArtifact,
  rejectArtifact,
  updateArtifact,
} from './artifacts.js'
import type { Author } from './events.js'
import { getArtifact, listArtifacts } from './reads.js'
import { initSeed } from './seed.js'

const RESEARCHER: Author = { actorType: 'researcher', actorId: 'juan@example.com' }
const AI: Author = {
  actorType: 'ai',
  actorId: 'claude-code:0.1.0:abc12345',
  model: 'anthropic:claude',
  promptHash: 'f'.repeat(64),
}

describe('listArtifacts', () => {
  let work: string
  let seed: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-reads-'))
    seed = initSeed('demo', { cwd: work }).path
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('returns [] for a seed with no event log', () => {
    assert.deepEqual(listArtifacts(seed, 'highlight'), [])
  })

  it('lists current snapshots of a kind, newest activity first', () => {
    createHighlight(seed, {
      sessionId: 'S001',
      utteranceId: 'U-1',
      span: [0, 1],
      text: 'a',
      author: RESEARCHER,
    })
    createHighlight(seed, {
      sessionId: 'S001',
      utteranceId: 'U-2',
      span: [0, 1],
      text: 'b',
      author: RESEARCHER,
    })

    const list = listArtifacts(seed, 'highlight')
    assert.equal(list.length, 2)
    // newest first: H-002 was created last
    assert.equal((list[0]?.current_state as { id: string }).id, 'H-002')
    assert.equal((list[1]?.current_state as { id: string }).id, 'H-001')
    assert.ok(list[0]?.last_event_ts)
  })

  it('does not bleed kinds together', () => {
    createHighlight(seed, {
      sessionId: 'S001',
      utteranceId: 'U-1',
      span: [0, 1],
      text: 'a',
      author: RESEARCHER,
    })
    createCode(seed, { name: 'Distrust', definition: 'd', author: RESEARCHER })
    assert.equal(listArtifacts(seed, 'highlight').length, 1)
    assert.equal(listArtifacts(seed, 'code').length, 1)
    assert.equal(listArtifacts(seed, 'theme').length, 0)
  })

  it('excludes rejected (archived) artifacts unless includeArchived', () => {
    const h = createHighlight(seed, {
      sessionId: 'S001',
      utteranceId: 'U-1',
      span: [0, 1],
      text: 'a',
      author: RESEARCHER,
    })
    rejectArtifact(seed, h.id, 'juan@example.com')
    assert.equal(listArtifacts(seed, 'highlight').length, 0)
    const withArchived = listArtifacts(seed, 'highlight', { includeArchived: true })
    assert.equal(withArchived.length, 1)
    assert.equal(withArchived[0]?.archived, true)
  })

  it('reflects endorsement in human_approved', () => {
    const c = createCode(seed, { name: 'Trust', definition: 'd', author: AI })
    assert.equal(listArtifacts(seed, 'code')[0]?.human_approved, false)
    endorseArtifact(seed, c.id, 'juan@example.com')
    assert.equal(listArtifacts(seed, 'code')[0]?.human_approved, true)
  })
})

describe('getArtifact', () => {
  let work: string
  let seed: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-reads-'))
    seed = initSeed('demo', { cwd: work }).path
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('resolves by human id', () => {
    const h = createHighlight(seed, {
      sessionId: 'S001',
      utteranceId: 'U-1',
      span: [0, 5],
      text: 'hi',
      author: RESEARCHER,
    })
    const snap = getArtifact(seed, 'highlight', 'H-001')
    assert.ok(snap)
    assert.equal(snap?.artifact_id, h.artifact_id)
    assert.equal((snap?.current_state as { id: string }).id, 'H-001')
  })

  it('resolves by SHA prefix', () => {
    const h = createHighlight(seed, {
      sessionId: 'S001',
      utteranceId: 'U-1',
      span: [0, 5],
      text: 'hi',
      author: RESEARCHER,
    })
    const snap = getArtifact(seed, 'highlight', h.artifact_id.slice(0, 12))
    assert.equal(snap?.artifact_id, h.artifact_id)
  })

  it('returns null for an unknown ref', () => {
    createHighlight(seed, {
      sessionId: 'S001',
      utteranceId: 'U-1',
      span: [0, 5],
      text: 'hi',
      author: RESEARCHER,
    })
    assert.equal(getArtifact(seed, 'highlight', 'H-999'), null)
  })
})

describe('rejectArtifact + updateArtifact lifecycle', () => {
  let work: string
  let seed: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-reads-'))
    seed = initSeed('demo', { cwd: work }).path
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('reject archives the artifact and chains the latest event', () => {
    const c = createCode(seed, { name: 'Distrust', definition: 'd', author: AI })
    const endorse = endorseArtifact(seed, c.id, 'juan@example.com')
    const res = rejectArtifact(seed, c.id, 'juan@example.com', 'duplicate')
    assert.equal(res.artifact_id, c.artifact_id)
    // chains the latest event (the endorse), not the create
    assert.equal(res.parent_event_id, endorse.endorse_event_id)
    const snap = getArtifact(seed, 'code', c.id)
    assert.equal(snap?.archived, true)
  })

  it('reject is idempotent per researcher', () => {
    const c = createCode(seed, { name: 'Distrust', definition: 'd', author: RESEARCHER })
    const first = rejectArtifact(seed, c.id, 'juan@example.com')
    const second = rejectArtifact(seed, c.id, 'juan@example.com')
    assert.equal(second.already_rejected, true)
    assert.equal(second.reject_event_id, first.reject_event_id)
  })

  it('update emits a field patch chaining the latest event', () => {
    const c = createCode(seed, { name: 'Distrust', definition: 'old', author: RESEARCHER })
    const res = updateArtifact(
      seed,
      c.id,
      { field: 'definition', before: 'old', after: 'new' },
      RESEARCHER,
    )
    assert.equal(res.artifact_id, c.artifact_id)
    const snap = getArtifact(seed, 'code', c.id)
    assert.equal((snap?.current_state as { definition: string }).definition, 'new')
  })
})
