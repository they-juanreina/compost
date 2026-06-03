import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { applyEvent, reduce } from '../src/reducer.js'
import type { Event } from '../src/types.js'

const KIND = 'highlight'
const ID = 'a'.repeat(64)

function makeEvent(overrides: Partial<Event>): Event {
  return {
    id: '01JM9NPC8QR3KVTW7XYZ2ABDFG',
    ts: '2026-06-02T14:00:00Z',
    artifact_kind: KIND,
    artifact_id: ID,
    action: 'create',
    actor_type: 'researcher',
    actor_id: 'juan',
    payload: {},
    parent_event: null,
    batch_id: null,
    ...overrides,
  }
}

describe('reducer.applyEvent', () => {
  it('initializes current_state from create payload', () => {
    const event = makeEvent({ payload: { text: 'hello', span: [0, 5] } })
    const snap = applyEvent(null, event)
    assert.equal(snap.version, 1)
    assert.equal(snap.last_event, event.id)
    assert.deepEqual(snap.current_state, { text: 'hello', span: [0, 5] })
  })

  it('researcher-create yields human_approved=true', () => {
    const snap = applyEvent(null, makeEvent({ actor_type: 'researcher' }))
    assert.equal(snap.human_approved, true)
  })

  it('ai-create yields human_approved=false', () => {
    const snap = applyEvent(
      null,
      makeEvent({
        actor_type: 'ai',
        actor_id: 'anthropic:claude',
        model: 'anthropic:claude',
        prompt_hash: 'b'.repeat(64),
      }),
    )
    assert.equal(snap.human_approved, false)
  })

  it('update with field-patch payload sets only that field', () => {
    const created = applyEvent(null, makeEvent({ payload: { text: 'before', other: 'keep' } }))
    const updated = applyEvent(
      created,
      makeEvent({
        id: '01JM9NPCAT5NXYV9ZABC4DEFGJ',
        action: 'update',
        payload: { field: 'text', before: 'before', after: 'after' },
        parent_event: created.last_event,
      }),
    )
    assert.equal(updated.version, 2)
    assert.equal(updated.current_state.text, 'after')
    assert.equal(updated.current_state.other, 'keep')
  })

  it('update with full object payload merges', () => {
    const created = applyEvent(null, makeEvent({ payload: { a: 1, b: 2 } }))
    const updated = applyEvent(
      created,
      makeEvent({
        id: '01JM9NPCAT5NXYV9ZABC4DEFGJ',
        action: 'update',
        payload: { b: 20, c: 30 },
        parent_event: created.last_event,
      }),
    )
    assert.deepEqual(updated.current_state, { a: 1, b: 20, c: 30 })
  })

  it('endorse flips human_approved to true and records endorser', () => {
    const aiCreate = applyEvent(
      null,
      makeEvent({
        actor_type: 'ai',
        actor_id: 'anthropic:claude',
        model: 'anthropic:claude',
        prompt_hash: 'b'.repeat(64),
        payload: { name: 'distrust' },
      }),
    )
    assert.equal(aiCreate.human_approved, false)
    const endorsed = applyEvent(
      aiCreate,
      makeEvent({
        id: '01JM9NPCAT5NXYV9ZABC4DEFGJ',
        action: 'endorse',
        payload: { note: 'aligns with trust theme' },
        parent_event: aiCreate.last_event,
      }),
    )
    assert.equal(endorsed.human_approved, true)
    const endorsement = endorsed.current_state._endorsement as Record<string, unknown>
    assert.equal(endorsement.endorsed_by, 'juan')
    assert.equal(endorsement.note, 'aligns with trust theme')
  })

  it('reject archives the artifact', () => {
    const created = applyEvent(null, makeEvent({ payload: { x: 1 } }))
    const rejected = applyEvent(
      created,
      makeEvent({
        id: '01JM9NPCAT5NXYV9ZABC4DEFGJ',
        action: 'reject',
        payload: { reason: 'wrong scope' },
        parent_event: created.last_event,
      }),
    )
    assert.equal(rejected.archived, true)
    assert.equal(rejected.human_approved, false)
    assert.equal(rejected.current_state.x, 1, 'state preserved for audit')
  })

  it('unlink archives a relationship', () => {
    const linked = applyEvent(
      null,
      makeEvent({ action: 'link', payload: { code_id: 'c', theme_id: 't' } }),
    )
    const unlinked = applyEvent(
      linked,
      makeEvent({
        id: '01JM9NPCAT5NXYV9ZABC4DEFGJ',
        action: 'unlink',
        payload: { reason: 'wrong grouping' },
        parent_event: linked.last_event,
      }),
    )
    assert.equal(unlinked.archived, true)
  })

  it('throws on artifact mismatch between snapshot and incoming event', () => {
    const snap = applyEvent(null, makeEvent({}))
    assert.throws(() => applyEvent(snap, makeEvent({ artifact_id: 'b'.repeat(64) })), /mismatch/)
  })
})

describe('reducer.reduce', () => {
  it('returns null for an empty event list', () => {
    assert.equal(reduce([]), null)
  })

  it('folds a chain of events into the final snapshot', () => {
    const events: Event[] = [
      makeEvent({ id: '01JM9NPC8QR3KVTW7XYZ2ABDFG', payload: { count: 0 } }),
      makeEvent({
        id: '01JM9NPC9SR4MWTX8YZB3CDEFH',
        action: 'update',
        payload: { field: 'count', after: 1 },
        parent_event: '01JM9NPC8QR3KVTW7XYZ2ABDFG',
      }),
      makeEvent({
        id: '01JM9NPCAT5NXYV9ZABC4DEFGJ',
        action: 'update',
        payload: { field: 'count', after: 2 },
        parent_event: '01JM9NPC9SR4MWTX8YZB3CDEFH',
      }),
    ]
    const snap = reduce(events)
    assert.ok(snap)
    assert.equal(snap.version, 3)
    assert.equal(snap.current_state.count, 2)
    assert.equal(snap.last_event, '01JM9NPCAT5NXYV9ZABC4DEFGJ')
  })

  it('is pure — same input produces same output across runs', () => {
    const events = [
      makeEvent({ id: '01JM9NPC8QR3KVTW7XYZ2ABDFG', payload: { x: 1 } }),
      makeEvent({
        id: '01JM9NPC9SR4MWTX8YZB3CDEFH',
        action: 'update',
        payload: { x: 2 },
        parent_event: '01JM9NPC8QR3KVTW7XYZ2ABDFG',
      }),
    ]
    assert.deepEqual(reduce(events), reduce(events))
  })
})
