import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createCode, createHighlight } from '../lib/artifacts.js'
import { eventsToProvO } from './prov.js'

const HASH = 'a'.repeat(64)

describe('eventsToProvO', () => {
  let seed: string
  beforeEach(() => {
    seed = mkdtempSync(join(tmpdir(), 'compost-prov-'))
  })
  afterEach(() => {
    rmSync(seed, { recursive: true, force: true })
  })

  it('serializes the event log to PROV-O JSON-LD with the core relations', () => {
    // an AI code with captured inputs, and a researcher highlight
    createCode(seed, {
      name: 'distrust',
      definition: 'd',
      author: {
        actorType: 'ai',
        actorId: 'anthropic:claude-opus-4-8',
        model: 'm',
        promptHash: HASH,
      },
      inputs: { model: 'm', prompt: 'suggest a code', context: [{ utterance_id: 'U-0001' }] },
    })
    createHighlight(seed, {
      sessionId: 'S001',
      utteranceId: 'U-0001',
      span: [0, 5],
      text: 'hello',
      author: { actorType: 'researcher', actorId: 'juan@x' },
    })

    const prov = eventsToProvO(join(seed, '.compost', 'events.sqlite'))
    assert.equal(prov.activities, 2)
    assert.equal(prov.entities, 2) // code + highlight artifacts
    assert.equal(prov.agents, 2) // ai actor + researcher
    assert.equal(prov.inputs, 1) // the AI create captured inputs

    const graph = prov.document['@graph'] as Array<Record<string, unknown>>
    assert.ok(prov.document['@context'])

    // the AI actor is typed as an AIAgent
    const aiAgent = graph.find(
      (n) => Array.isArray(n['@type']) && (n['@type'] as string[]).includes('provagent:AIAgent'),
    )
    assert.ok(aiAgent, 'expected a provagent:AIAgent node')

    // the AI create Activity prov:used its input bundle entity
    const inputEntity = graph.find(
      (n) => n['compost:kind'] === 'ai_input_bundle' && n['@type'] === 'prov:Entity',
    )
    assert.ok(inputEntity, 'expected an ai_input_bundle entity')

    // researcher is a prov:Person
    const person = graph.find(
      (n) => Array.isArray(n['@type']) && (n['@type'] as string[]).includes('prov:Person'),
    )
    assert.ok(person, 'expected a prov:Person node')

    // every create Activity generated an entity
    const creates = graph.filter((n) => n['compost:action'] === 'create')
    assert.equal(creates.length, 2)
    for (const c of creates) assert.ok(c['prov:generated'], 'create Activity generates an entity')
  })

  it('throws when the events db is missing', () => {
    assert.throws(() => eventsToProvO(join(seed, 'nope', 'events.sqlite')), /No events.sqlite/)
  })
})
