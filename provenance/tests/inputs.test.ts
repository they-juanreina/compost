import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type AiInputBundle, canonicalJson, inputId } from '../src/inputs.js'
import type { EventInput } from '../src/types.js'
import { EventWriter } from '../src/writer.js'

const ARTIFACT_ID = 'a'.repeat(64)
const PROMPT_HASH = 'b'.repeat(64)

function bundle(over: Partial<AiInputBundle> = {}): AiInputBundle {
  return {
    model: 'anthropic:claude-opus-4-8',
    params: { temperature: 0.2, max_tokens: 512 },
    system_prompt: 'You code qualitative interview data.',
    prompt: 'Suggest a code for: "I never trust the alert."',
    context: [{ utterance_id: 'U-0001', quote: 'I never trust the alert.' }],
    ...over,
  }
}

describe('canonicalJson', () => {
  it('sorts object keys recursively so insertion order is irrelevant', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } })
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 })
    assert.equal(a, b)
    assert.equal(a, '{"a":{"c":3,"d":2},"b":1}')
  })

  it('preserves array order', () => {
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]')
  })

  it('drops undefined values', () => {
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}')
  })
})

describe('inputId', () => {
  it('is a 64-char sha256 hex', () => {
    assert.match(inputId(bundle()), /^[a-f0-9]{64}$/)
  })

  it('is stable regardless of param key order (canonicalized)', () => {
    const a = inputId(bundle({ params: { temperature: 0.2, max_tokens: 512 } }))
    const b = inputId(bundle({ params: { max_tokens: 512, temperature: 0.2 } }))
    assert.equal(a, b)
  })

  it('treats missing optionals the same as null', () => {
    const withNulls = inputId({ model: 'm', prompt: 'p', params: null, system_prompt: null })
    const without = inputId({ model: 'm', prompt: 'p' })
    assert.equal(withNulls, without)
  })

  it('changes when any input changes', () => {
    const base = inputId(bundle())
    assert.notEqual(base, inputId(bundle({ prompt: 'different prompt' })))
    assert.notEqual(base, inputId(bundle({ model: 'ollama:llama3.1:8b' })))
    assert.notEqual(base, inputId(bundle({ params: { temperature: 0.9 } })))
    assert.notEqual(base, inputId(bundle({ context: [{ utterance_id: 'U-0002' }] })))
  })
})

describe('EventWriter input persistence (migration 0003)', () => {
  it('applies 0003 — ai_inputs table and events.input_id column exist', () => {
    const w = new EventWriter({ dbPath: ':memory:' })
    // @ts-expect-error: reach into private db for the assertion only
    const tbl = w.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_inputs'")
      .get()
    assert.ok(tbl, 'ai_inputs table exists')
    // @ts-expect-error: private db
    const cols = w.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>
    assert.ok(
      cols.some((c) => c.name === 'input_id'),
      'events.input_id column exists',
    )
    w.close()
  })

  it('recordInputs persists and dedupes on input_id; readInputs round-trips', () => {
    const w = new EventWriter({ dbPath: ':memory:' })
    const id1 = w.recordInputs(bundle())
    const id2 = w.recordInputs(bundle()) // identical → same id, no second row
    assert.equal(id1, id2)
    // @ts-expect-error: private db
    const count = w.db.prepare('SELECT COUNT(*) AS c FROM ai_inputs').get() as { c: number }
    assert.equal(count.c, 1)

    const row = w.readInputs(id1)
    assert.ok(row)
    assert.equal(row?.model, 'anthropic:claude-opus-4-8')
    assert.deepEqual(row?.params, { temperature: 0.2, max_tokens: 512 })
    assert.deepEqual(row?.context, [{ utterance_id: 'U-0001', quote: 'I never trust the alert.' }])
    w.close()
  })

  it('readInputs returns undefined for an unknown id', () => {
    const w = new EventWriter({ dbPath: ':memory:' })
    assert.equal(w.readInputs('c'.repeat(64)), undefined)
    w.close()
  })

  it('an AI event referencing a recorded bundle persists input_id', () => {
    const w = new EventWriter({ dbPath: ':memory:' })
    const id = w.recordInputs(bundle())
    const event: EventInput = {
      artifact_kind: 'code',
      artifact_id: ARTIFACT_ID,
      action: 'create',
      actor_type: 'ai',
      actor_id: 'anthropic:claude-opus-4-8',
      model: 'anthropic:claude-opus-4-8',
      prompt_hash: PROMPT_HASH,
      input_id: id,
      payload: { kind: 'code', name: 'distrust-of-automation' },
    }
    const e = w.appendEvent(event)
    // @ts-expect-error: private db
    const row = w.db.prepare('SELECT input_id FROM events WHERE id = ?').get(e.id) as {
      input_id: string | null
    }
    assert.equal(row.input_id, id)
    w.close()
  })

  it('rejects an event whose input_id has no ai_inputs row (FK enforced)', () => {
    const w = new EventWriter({ dbPath: ':memory:' })
    assert.throws(() =>
      w.appendEvent({
        artifact_kind: 'code',
        artifact_id: ARTIFACT_ID,
        action: 'create',
        actor_type: 'ai',
        actor_id: 'anthropic:claude-opus-4-8',
        model: 'anthropic:claude-opus-4-8',
        prompt_hash: PROMPT_HASH,
        input_id: 'd'.repeat(64), // never recorded
        payload: { kind: 'code' },
      }),
    )
    w.close()
  })
})
