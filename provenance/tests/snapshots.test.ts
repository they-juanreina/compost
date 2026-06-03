import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SnapshotStore } from '../src/snapshots.js'
import type { EventInput } from '../src/types.js'
import { EventWriter } from '../src/writer.js'

const KIND = 'highlight'
const ID = 'a'.repeat(64)
const KIND_B = 'code'
const ID_B = 'b'.repeat(64)
const PROMPT_HASH = 'c'.repeat(64)

function setup(): { writer: EventWriter; store: SnapshotStore } {
  const writer = new EventWriter({ dbPath: ':memory:' })
  return { writer, store: writer.snapshots() }
}

function highlight(payload: Record<string, unknown> = {}): EventInput {
  return {
    artifact_kind: KIND,
    artifact_id: ID,
    action: 'create',
    actor_type: 'researcher',
    actor_id: 'juan',
    payload: { text: 'hello', ...payload },
  }
}

describe('SnapshotStore.refresh', () => {
  it('returns null for an artifact with no events', () => {
    const { store, writer } = setup()
    assert.equal(store.refresh(KIND, ID), null)
    writer.close()
  })

  it('reduces all events for an artifact and upserts the snapshot', () => {
    const { writer, store } = setup()
    const created = writer.appendEvent(highlight())
    writer.appendEvent({
      artifact_kind: KIND,
      artifact_id: ID,
      action: 'update',
      actor_type: 'researcher',
      actor_id: 'juan',
      payload: { field: 'text', after: 'world' },
      parent_event: created.id,
    })
    const snap = store.refresh(KIND, ID)
    assert.ok(snap)
    assert.equal(snap.version, 2)
    assert.equal(snap.current_state.text, 'world')
    // round-trip through get()
    const fetched = store.get(KIND, ID)
    assert.deepEqual(fetched, snap)
    writer.close()
  })
})

describe('SnapshotStore.apply', () => {
  it('incrementally folds events as they arrive', () => {
    const { writer, store } = setup()
    const e1 = writer.appendEvent(highlight({ count: 0 }))
    const s1 = store.apply(e1)
    assert.equal(s1.version, 1)
    const e2 = writer.appendEvent({
      artifact_kind: KIND,
      artifact_id: ID,
      action: 'update',
      actor_type: 'researcher',
      actor_id: 'juan',
      payload: { field: 'count', after: 1 },
      parent_event: e1.id,
    })
    const s2 = store.apply(e2)
    assert.equal(s2.version, 2)
    assert.equal(s2.current_state.count, 1)
    writer.close()
  })

  it('endorse on an AI-authored artifact flips human_approved=true', () => {
    const { writer, store } = setup()
    const create = writer.appendEvent({
      artifact_kind: KIND,
      artifact_id: ID,
      action: 'create',
      actor_type: 'ai',
      actor_id: 'anthropic:claude',
      model: 'anthropic:claude',
      prompt_hash: PROMPT_HASH,
      payload: { suggestion: 'tag X' },
    })
    const before = store.apply(create)
    assert.equal(before.human_approved, false)
    const endorse = writer.appendEvent({
      artifact_kind: KIND,
      artifact_id: ID,
      action: 'endorse',
      actor_type: 'researcher',
      actor_id: 'juan',
      payload: { note: 'good catch' },
      parent_event: create.id,
    })
    const after = store.apply(endorse)
    assert.equal(after.human_approved, true)
    writer.close()
  })
})

describe('SnapshotStore.rebuildAll', () => {
  it('rebuilds every artifact from scratch and returns the count', () => {
    const { writer, store } = setup()
    writer.appendEvent(highlight())
    writer.appendEvent({
      artifact_kind: KIND_B,
      artifact_id: ID_B,
      action: 'create',
      actor_type: 'researcher',
      actor_id: 'juan',
      payload: { name: 'code-a' },
    })
    const n = store.rebuildAll()
    assert.equal(n, 2)
    const a = store.get(KIND, ID)
    const b = store.get(KIND_B, ID_B)
    assert.ok(a)
    assert.ok(b)
    assert.equal(a.version, 1)
    assert.equal(b.version, 1)
    writer.close()
  })

  it('is idempotent — rebuilding twice yields identical snapshots', () => {
    const { writer, store } = setup()
    writer.appendEvent(highlight())
    store.rebuildAll()
    const first = store.get(KIND, ID)
    store.rebuildAll()
    const second = store.get(KIND, ID)
    assert.deepEqual(first, second)
    writer.close()
  })
})
