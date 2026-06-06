import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createCode, createHighlight } from '../lib/artifacts.js'
import { emitAgentCreate, openSeedEvents } from '../lib/events.js'
import { eventsToProvO } from './prov.js'

const HASH = 'a'.repeat(64)

function hasType(node: Record<string, unknown>, t: string): boolean {
  const ty = node['@type']
  return Array.isArray(ty) ? (ty as string[]).includes(t) : ty === t
}

describe('eventsToProvO', () => {
  let seed: string
  beforeEach(() => {
    seed = mkdtempSync(join(tmpdir(), 'compost-prov-'))
  })
  afterEach(() => {
    rmSync(seed, { recursive: true, force: true })
  })

  it('serializes the event log to PROV-AGENT JSON-LD', () => {
    // an AI code with captured inputs (→ AIModelInvocation, Prompt, AIModel, ResponseData)
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
    // a researcher highlight (→ prov:Person)
    createHighlight(seed, {
      sessionId: 'S001',
      utteranceId: 'U-0001',
      span: [0, 5],
      text: 'hello',
      author: { actorType: 'researcher', actorId: 'juan@x' },
    })
    // a deterministic agent code (→ AgentTool)
    const w = openSeedEvents(seed)
    emitAgentCreate(w, {
      artifactKind: 'code',
      initialState: { kind: 'code', members: ['H-001'] },
      agentName: 'similarity-scanner',
      agentVersion: '0.1.0',
    })
    w.close()

    const prov = eventsToProvO(join(seed, '.compost', 'events.sqlite'))
    assert.equal(prov.activities, 3)
    assert.equal(prov.entities, 3) // ai code + highlight + scanner code
    assert.equal(prov.agents, 3) // ai actor + researcher + scanner agent
    assert.equal(prov.inputs, 1) // the AI create captured inputs
    assert.equal(prov.models, 1) // model 'm'
    assert.equal(prov.tools, 1) // the similarity-scanner

    const graph = prov.document['@graph'] as Array<Record<string, unknown>>
    assert.ok(prov.document['@context'])

    // PROV-AGENT classes are all present
    assert.ok(
      graph.some((n) => hasType(n, 'provagent:AIAgent')),
      'AIAgent',
    )
    assert.ok(
      graph.some((n) => hasType(n, 'provagent:AIModelInvocation')),
      'AIModelInvocation',
    )
    assert.ok(
      graph.some((n) => hasType(n, 'provagent:AIModel')),
      'AIModel',
    )
    assert.ok(
      graph.some((n) => hasType(n, 'provagent:Prompt')),
      'Prompt',
    )
    assert.ok(
      graph.some((n) => hasType(n, 'provagent:ResponseData')),
      'ResponseData',
    )
    assert.ok(
      graph.some((n) => hasType(n, 'provagent:AgentTool')),
      'AgentTool',
    )
    assert.ok(
      graph.some((n) => hasType(n, 'prov:Person')),
      'Person',
    )

    // the AI invocation prov:used both a Prompt and an AIModel
    const invocation = graph.find((n) => hasType(n, 'provagent:AIModelInvocation'))
    assert.ok(invocation)
    const used = ([] as Array<{ '@id': string }>).concat(
      (invocation?.['prov:used'] as Array<{ '@id': string }>) ?? [],
    )
    assert.ok(
      used.some((u) => u['@id'].startsWith('compost:model/')),
      'invocation used an AIModel',
    )
    assert.ok(
      used.some((u) => u['@id'].startsWith('compost:input/')),
      'invocation used a Prompt',
    )

    // every create Activity generated an entity
    const creates = graph.filter((n) => n['compost:action'] === 'create')
    assert.equal(creates.length, 3)
    for (const c of creates) assert.ok(c['prov:generated'], 'create Activity generates an entity')
  })

  it('throws when the events db is missing', () => {
    assert.throws(() => eventsToProvO(join(seed, 'nope', 'events.sqlite')), /No events.sqlite/)
  })
})
