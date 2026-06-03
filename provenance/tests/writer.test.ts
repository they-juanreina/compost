import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ProvenanceError } from '../src/errors.js'
import type { EventInput } from '../src/types.js'
import { EventWriter } from '../src/writer.js'

const ARTIFACT_ID = 'a'.repeat(64)
const PROMPT_HASH = 'b'.repeat(64)

function makeWriter(): EventWriter {
  return new EventWriter({ dbPath: ':memory:' })
}

function researcherCreate(): EventInput {
  return {
    artifact_kind: 'highlight',
    artifact_id: ARTIFACT_ID,
    action: 'create',
    actor_type: 'researcher',
    actor_id: 'juan@they-juanreina',
    payload: { session_id: 'S023', utterance_id: 'U-0001' },
  }
}

describe('EventWriter.appendEvent', () => {
  it('materializes id and ts when missing', () => {
    const w = makeWriter()
    const e = w.appendEvent(researcherCreate())
    assert.match(e.id, /^[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/)
    w.close()
  })

  it('persists the row in events table', () => {
    const w = makeWriter()
    const e = w.appendEvent(researcherCreate())
    // @ts-expect-error: reach into private db for the assertion only
    const row = w.db.prepare('SELECT * FROM events WHERE id = ?').get(e.id) as Record<
      string,
      unknown
    >
    assert.equal(row.action, 'create')
    assert.equal(row.actor_type, 'researcher')
    const payload = JSON.parse(row.payload as string) as { session_id: string }
    assert.equal(payload.session_id, 'S023')
    w.close()
  })

  it('is idempotent on event ID — duplicate appends do not throw or insert', () => {
    const w = makeWriter()
    const e = w.appendEvent(researcherCreate())
    const again = w.appendEvent({ ...researcherCreate(), id: e.id, ts: e.ts })
    assert.equal(again.id, e.id)
    // @ts-expect-error: private db
    const count = w.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }
    assert.equal(count.c, 1)
    w.close()
  })

  it('rejects an event with an invalid actor_type', () => {
    const w = makeWriter()
    assert.throws(
      () =>
        w.appendEvent({
          ...researcherCreate(),
          actor_type: 'system' as never,
        }),
      ProvenanceError,
    )
    w.close()
  })

  it('enforces agent_name + agent_version when actor_type=agent', () => {
    const w = makeWriter()
    assert.throws(
      () =>
        w.appendEvent({
          ...researcherCreate(),
          actor_type: 'agent',
          actor_id: 'similarity-scanner@0.2.1',
        }),
      ProvenanceError,
    )
    w.close()
  })

  it('enforces model + prompt_hash when actor_type=ai', () => {
    const w = makeWriter()
    assert.throws(
      () =>
        w.appendEvent({
          ...researcherCreate(),
          actor_type: 'ai',
          actor_id: 'anthropic:claude-opus-4-7',
        }),
      ProvenanceError,
    )
    w.close()
  })

  it('accepts an AI event with required fields', () => {
    const w = makeWriter()
    const e = w.appendEvent({
      ...researcherCreate(),
      actor_type: 'ai',
      actor_id: 'anthropic:claude-opus-4-7',
      model: 'anthropic:claude-opus-4-7',
      prompt_hash: PROMPT_HASH,
    })
    assert.equal(e.actor_type, 'ai')
    w.close()
  })

  it('requires parent_event for endorse actions', () => {
    const w = makeWriter()
    assert.throws(
      () =>
        w.appendEvent({
          ...researcherCreate(),
          action: 'endorse',
        }),
      ProvenanceError,
    )
    w.close()
  })
})

describe('EventWriter.appendBatch', () => {
  it('writes all events in a single transaction tagged with batch_id', () => {
    const w = makeWriter()
    const events = w.appendBatch(
      [researcherCreate(), researcherCreate(), researcherCreate()],
      'loop:test:001',
    )
    assert.equal(events.length, 3)
    for (const e of events) assert.equal(e.batch_id, 'loop:test:001')
    // @ts-expect-error: private db
    const rows = w.db
      .prepare('SELECT id FROM events WHERE batch_id = ?')
      .all('loop:test:001') as Array<{ id: string }>
    assert.equal(rows.length, 3)
    w.close()
  })

  it('rolls back the whole transaction if any event fails validation', () => {
    const w = makeWriter()
    const valid = researcherCreate()
    const invalid: EventInput = { ...researcherCreate(), actor_type: 'system' as never }
    assert.throws(() => w.appendBatch([valid, invalid, valid], 'loop:bad:001'), ProvenanceError)
    // @ts-expect-error: private db
    const count = w.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }
    assert.equal(count.c, 0, 'no events should have landed')
    w.close()
  })

  it('rejects empty batchId', () => {
    const w = makeWriter()
    assert.throws(() => w.appendBatch([researcherCreate()], ''), ProvenanceError)
    w.close()
  })
})

describe('EventWriter migrations', () => {
  it('applies every shipped migration on first open and records it in schema_migrations', () => {
    const w = new EventWriter({ dbPath: ':memory:' })
    // @ts-expect-error: private db
    const rows = w.db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{
      version: number
    }>
    const versions = rows.map((r) => r.version)
    assert.ok(versions.length > 0, 'at least one migration applied')
    assert.equal(versions[0], 1, 'first migration is 0001_init')
    // versions are strictly increasing starting from 1
    for (let i = 1; i < versions.length; i++) {
      assert.equal(versions[i], (versions[i - 1] ?? 0) + 1)
    }
    w.close()
  })
})
