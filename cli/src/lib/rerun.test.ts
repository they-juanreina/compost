import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { createCode } from './artifacts.js'
import { type AiInputBundle, emitAgentCreate, openSeedEvents } from './events.js'
import { diffPayload, rerunEvent } from './rerun.js'

const HASH = 'a'.repeat(64)

describe('diffPayload', () => {
  it('detects changed/added/removed fields', () => {
    const d = diffPayload({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })
    assert.equal(d.changed, true)
    const fields = d.fields.map((f) => f.field).sort()
    assert.deepEqual(fields, ['b', 'c'])
  })
  it('no change → changed=false', () => {
    assert.equal(diffPayload({ a: [1, 2] }, { a: [1, 2] }).changed, false)
  })
})

describe('rerunEvent', () => {
  let seed: string
  beforeEach(() => {
    seed = mkdtempSync(join(tmpdir(), 'compost-rerun-'))
  })
  afterEach(() => {
    rmSync(seed, { recursive: true, force: true })
  })

  function scannerCodeWithInputs(): string {
    const w = openSeedEvents(seed)
    const inputs: AiInputBundle = {
      model: 'similarity-scanner@0.1.0',
      params: { threshold: 0.75 },
      prompt: 'cosine-cluster 3 highlights',
      context: { highlight_ids: ['H-001', 'H-002', 'H-003'], members: ['H-001', 'H-002'] },
    }
    const e = emitAgentCreate(w, {
      artifactKind: 'code',
      initialState: { kind: 'code', members: ['H-001', 'H-002'], cohesion: 0.9, status: 'draft' },
      agentName: 'similarity-scanner',
      agentVersion: '0.1.0',
      inputs,
    })
    w.close()
    return e.id
  }

  it('verify mode confirms inputs are intact and reconstructable', async () => {
    const eventId = scannerCodeWithInputs()
    const r = await rerunEvent(seed, { ref: eventId })
    assert.equal(r.status, 'verified')
    assert.equal(r.integrity_ok, true)
    assert.equal(r.actor_type, 'agent')
    assert.equal(r.create_event_id, eventId)
  })

  it('refuses an event with no captured inputs (input_id NULL)', async () => {
    const created = createCode(seed, {
      name: 'no-inputs',
      definition: 'x',
      author: { actorType: 'ai', actorId: 'claude-code:0.1.0:ab', model: 'm', promptHash: HASH },
    })
    await assert.rejects(() => rerunEvent(seed, { ref: created.id }), /no captured inputs/)
  })

  it('apply regenerates via the injected generator and emits a chained event + diff', async () => {
    const eventId = scannerCodeWithInputs()
    const r = await rerunEvent(seed, {
      ref: eventId,
      apply: true,
      // simulate a regeneration that drops one member
      regenerate: async () => ({
        kind: 'code',
        members: ['H-001'],
        cohesion: 0.8,
        status: 'draft',
      }),
    })
    assert.equal(r.status, 'regenerated')
    assert.ok(r.regenerated_event_id)
    assert.equal(r.diff?.changed, true)
    assert.ok(r.diff?.fields.some((f) => f.field === 'members'))

    // a chained update event landed, parent = the original create
    const db = new Database(join(seed, '.compost', 'events.sqlite'), { readonly: true })
    try {
      const row = db
        .prepare('SELECT action, parent_event, actor_type FROM events WHERE id = ?')
        .get(r.regenerated_event_id) as {
        action: string
        parent_event: string
        actor_type: string
      }
      assert.equal(row.action, 'update')
      assert.equal(row.parent_event, eventId)
      assert.equal(row.actor_type, 'agent')
    } finally {
      db.close()
    }
  })

  it('throws a clear error for an unknown ref', async () => {
    scannerCodeWithInputs()
    await assert.rejects(() => rerunEvent(seed, { ref: 'Z'.repeat(26) }), /No create event found/)
  })
})
