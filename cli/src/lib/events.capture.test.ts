import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { EventWriter, inputId } from '@they-juanreina/compost-provenance'
import Database from 'better-sqlite3'

import { createCode } from './artifacts.js'
import { type AiInputBundle, emitAgentCreate, openSeedEvents } from './events.js'

const HASH = 'a'.repeat(64)

function bundle(): AiInputBundle {
  return {
    model: 'anthropic:claude-opus-4-8',
    params: { temperature: 0.2 },
    prompt: 'Suggest a code.',
    context: [{ utterance_id: 'U-0001' }],
  }
}

describe('input capture wiring', () => {
  let seed: string

  beforeEach(() => {
    seed = mkdtempSync(join(tmpdir(), 'compost-capture-'))
  })
  afterEach(() => {
    rmSync(seed, { recursive: true, force: true })
  })

  function readEventInputId(artifactId: string): string | null {
    const db = new Database(join(seed, '.compost', 'events.sqlite'), { readonly: true })
    try {
      const row = db
        .prepare("SELECT input_id FROM events WHERE artifact_id = ? AND action = 'create'")
        .get(artifactId) as { input_id: string | null } | undefined
      return row?.input_id ?? null
    } finally {
      db.close()
    }
  }

  it('an AI create with an inputs bundle links input_id (host best-effort path)', () => {
    const created = createCode(seed, {
      name: 'distrust-of-automation',
      definition: 'Participant distrusts automated alerts.',
      author: { actorType: 'ai', actorId: 'claude-code:0.1.0:ab', model: 'm', promptHash: HASH },
      inputs: bundle(),
    })
    assert.equal(readEventInputId(created.artifact_id), inputId(bundle()))

    // and the bundle is reconstructable
    const w = new EventWriter({ dbPath: join(seed, '.compost', 'events.sqlite') })
    const row = w.readInputs(inputId(bundle()))
    assert.equal(row?.prompt, 'Suggest a code.')
    assert.deepEqual(row?.context, [{ utterance_id: 'U-0001' }])
    w.close()
  })

  it('a create without inputs leaves input_id NULL (hash-only, as before)', () => {
    const created = createCode(seed, {
      name: 'no-inputs',
      definition: 'x',
      author: { actorType: 'ai', actorId: 'claude-code:0.1.0:ab', model: 'm', promptHash: HASH },
    })
    assert.equal(readEventInputId(created.artifact_id), null)
  })

  it('emitAgentCreate records deterministic inputs (similarity-scanner path)', () => {
    const writer = openSeedEvents(seed)
    const inputs: AiInputBundle = {
      model: 'similarity-scanner@0.1.0',
      params: { threshold: 0.75 },
      prompt: 'cosine-cluster 3 highlights',
      context: { highlight_ids: ['H-001', 'H-002', 'H-003'], members: ['H-001', 'H-002'] },
    }
    const e = emitAgentCreate(writer, {
      artifactKind: 'code',
      initialState: { kind: 'code', members: ['H-001', 'H-002'] },
      agentName: 'similarity-scanner',
      agentVersion: '0.1.0',
      inputs,
    })
    assert.equal(e.input_id, inputId(inputs))
    writer.close()
    assert.equal(readEventInputId(e.artifact_id), inputId(inputs))
  })
})
