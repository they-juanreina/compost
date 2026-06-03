import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { reduce, type Snapshot } from '../../src/reducer.js'
import type { Action, ActorType, Event, EventInput } from '../../src/types.js'
import { EventWriter } from '../../src/writer.js'

const ARTIFACT_KIND = 'highlight'
const ARTIFACT_ID = 'a'.repeat(64)
const PROMPT_HASH = 'b'.repeat(64)

/**
 * Deterministic LCG — only used to make this property test reproducible across
 * CI runs. Don't reach for it in production code.
 */
function seededRng(seed: number): () => number {
  let s = seed | 0 || 1
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  const item = arr[Math.floor(rng() * arr.length)]
  if (item === undefined) throw new Error('empty pick')
  return item
}

function generate(seed: number, count: number): EventInput[] {
  const rng = seededRng(seed)
  const inputs: EventInput[] = []
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      inputs.push({
        artifact_kind: ARTIFACT_KIND,
        artifact_id: ARTIFACT_ID,
        action: 'create',
        actor_type: 'researcher',
        actor_id: 'juan',
        payload: { text: 'initial', count: 0, tags: [] },
      })
      continue
    }
    const action = pick<Action>(rng, ['update', 'update', 'update', 'endorse', 'reject'])
    const actor_type: ActorType = pick(rng, ['researcher', 'agent', 'ai'])
    const base: EventInput = {
      artifact_kind: ARTIFACT_KIND,
      artifact_id: ARTIFACT_ID,
      action,
      actor_type,
      actor_id: actor_type === 'ai' ? 'anthropic:claude' : 'juan',
      payload: null,
      parent_event: null,
    }
    if (actor_type === 'ai') {
      base.model = 'anthropic:claude'
      base.prompt_hash = PROMPT_HASH
    }
    if (actor_type === 'agent') {
      base.agent_name = 'sim-scanner'
      base.agent_version = '0.1.0'
    }
    if (action === 'update') {
      base.payload = { field: pick(rng, ['text', 'count']), after: Math.floor(rng() * 1000) }
    } else if (action === 'endorse') {
      base.payload = { note: 'ok' }
    } else if (action === 'reject') {
      base.payload = { reason: 'no' }
    }
    inputs.push(base)
  }
  return inputs
}

function snapshotsEqual(a: Snapshot | null, b: Snapshot | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

describe('property: snapshot incremental == batch', () => {
  for (const { seed, count } of [
    { seed: 1, count: 50 },
    { seed: 42, count: 200 },
    { seed: 7, count: 500 },
    { seed: 137, count: 1000 },
  ]) {
    it(`seed=${seed} count=${count}: applying events one by one matches refresh from scratch`, () => {
      // Single writer + single event stream — comparing different reduction
      // strategies over the same events (which therefore share IDs).
      const writer = new EventWriter({ dbPath: ':memory:' })
      const store = writer.snapshots()

      const inputs = generate(seed, count)
      const events: Event[] = []
      let parent: string | null = null

      for (const input of inputs) {
        const event = writer.appendEvent({ ...input, parent_event: parent })
        events.push(event)
        store.apply(event) // incremental fold
        if (input.action === 'create' || input.action === 'update' || input.action === 'endorse') {
          parent = event.id
        }
      }

      const incremental = store.get(ARTIFACT_KIND, ARTIFACT_ID)
      // Wipe and re-reduce from scratch
      store.refresh(ARTIFACT_KIND, ARTIFACT_ID)
      const refreshed = store.get(ARTIFACT_KIND, ARTIFACT_ID)
      const pure = reduce(events)

      assert.ok(snapshotsEqual(incremental, refreshed), 'incremental vs refresh diverged')
      assert.ok(snapshotsEqual(incremental, pure), 'incremental vs pure-reduce diverged')

      writer.close()
    })
  }
})
