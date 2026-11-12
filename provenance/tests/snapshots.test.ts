import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SnapshotStore } from '../src/snapshots.js'
import type { Event, EventInput } from '../src/types.js'
import { monotonicUlid } from '../src/ulid.js'
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

describe('replay order is deterministic across ledgers (ADR 0008)', () => {
  // Two coders edit the same artifact from the same starting point, in the same
  // millisecond, then both ledgers are merged. Every event shares ONE timestamp,
  // so only the tie-break decides the fold. Under `ORDER BY ts, rowid` the
  // winning edit depends on which ledger's copy was inserted first; under
  // `ts, id` every ledger folds identically. (Parents always precede children —
  // the parent_event foreign key requires it — so the orders differ only where
  // events are causally independent, which is exactly the merge case.)
  const TS = '2026-11-11T12:00:00.000Z'
  const next = monotonicUlid({ now: () => Date.parse(TS) })
  const create = next()
  const editJuan = next()
  const editAna = next()
  const endorseLuis = next()
  const other = next()
  const onA = { artifact_kind: KIND, artifact_id: ID, ts: TS, batch_id: null }
  const byId: Record<string, Event> = {
    [create]: { ...highlight(), ...onA, id: create, parent_event: null },
    [editJuan]: {
      ...onA,
      action: 'update',
      actor_type: 'researcher',
      actor_id: 'juan',
      payload: { field: 'text', after: 'juan' },
      id: editJuan,
      parent_event: create,
    },
    [editAna]: {
      ...onA,
      action: 'update',
      actor_type: 'researcher',
      actor_id: 'ana',
      payload: { field: 'text', after: 'ana' },
      id: editAna,
      parent_event: create,
    },
    [endorseLuis]: {
      ...onA,
      action: 'endorse',
      actor_type: 'researcher',
      actor_id: 'luis',
      payload: {},
      id: endorseLuis,
      parent_event: create,
    },
    [other]: {
      artifact_kind: KIND_B,
      artifact_id: ID_B,
      action: 'create',
      actor_type: 'ai',
      actor_id: 'claude-code:0.2.2:abc12345',
      model: 'm',
      prompt_hash: PROMPT_HASH,
      payload: { name: 'code-a' },
      id: other,
      ts: TS,
      parent_event: null,
      batch_id: null,
    },
  }

  function ledger(order: string[]): { a: unknown; b: unknown } {
    const writer = new EventWriter({ dbPath: ':memory:' })
    for (const id of order) writer.appendEvent(byId[id] as Event)
    const store = writer.snapshots()
    store.rebuildAll()
    const out = { a: store.get(KIND, ID), b: store.get(KIND_B, ID_B) }
    writer.close()
    return out
  }

  it('the same events inserted in different orders reduce to identical snapshots', () => {
    const forward = ledger([create, editJuan, editAna, endorseLuis, other])
    const anaFirst = ledger([other, create, editAna, endorseLuis, editJuan])
    const endorseFirst = ledger([create, endorseLuis, editAna, other, editJuan])
    assert.deepEqual(anaFirst, forward)
    assert.deepEqual(endorseFirst, forward)
    const a = forward.a as {
      current_state: { text: string }
      version: number
      last_event: string
      human_approved: boolean
    }
    assert.equal(a.current_state.text, 'ana', 'the higher (ts, id) edit is applied last')
    assert.equal(a.version, 4)
    assert.equal(a.last_event, endorseLuis)
    assert.equal(a.human_approved, true)
  })
})
