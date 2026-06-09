import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createArtifact } from '../actions.js'
import { ApiError } from './http.js'
import { blameForSeed, chatRetrieve, loadAgents, saveAgents } from './intelligence.js'

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'compost-web-intel-'))
  mkdirSync(join(work, 'Seeds', 'demo'), { recursive: true })
  process.env.COMPOST_ROOT = work
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
  delete process.env.COMPOST_ROOT
})

function writeTranscript(): void {
  const sdir = join(work, 'Seeds', 'demo', 'sessions', 'S001')
  mkdirSync(sdir, { recursive: true })
  writeFileSync(
    join(sdir, 'transcript.json'),
    JSON.stringify({
      session_id: 'S001',
      duration_ms: 4000,
      utterances: [
        {
          id: 'U-1',
          speaker_id: 'S2',
          text: 'No sé si confiar en la alerta',
          start_ms: 0,
          end_ms: 2000,
        },
        { id: 'U-2', speaker_id: 'S1', text: 'por qué no confías', start_ms: 2000, end_ms: 4000 },
      ],
    }),
  )
}

describe('agents journal', () => {
  it('GET on an empty seed returns an empty draft + no versions', () => {
    assert.deepEqual(loadAgents('demo'), { draft: '', versions: [] })
  })

  it('save then load round-trips the draft (append mode, no git)', () => {
    const res = saveAgents('demo', 'be concise', '2026-06-07T00:00:00Z', false)
    assert.equal(res.ok, true)
    assert.equal(res.mode, 'append')
    assert.equal(res.rerunRequested, false)
    assert.equal(loadAgents('demo').draft, 'be concise')
  })

  it('a second save snapshots the prior draft as a version', () => {
    saveAgents('demo', 'v1', '2026-06-07T00:00:00Z', false)
    saveAgents('demo', 'v2', '2026-06-07T01:00:00Z', true)
    const j = loadAgents('demo')
    assert.equal(j.draft, 'v2')
    assert.equal(j.versions.length, 1)
    assert.equal(j.versions[0]?.body, 'v1')
  })
})

describe('blame', () => {
  it('returns the lineage chain for a created artifact', () => {
    createArtifact(
      'demo',
      'code',
      { actorType: 'researcher', actorId: 'juan@example.com' },
      {
        name: 'Distrust',
        definition: 'd',
      },
    )
    const result = blameForSeed('demo', 'C-distrust')
    assert.equal(result.events.length, 1)
    assert.equal(result.events[0]?.action, 'create')
    assert.equal(result.events[0]?.actor_type, 'researcher')
  })
})

describe('chat retrieval', () => {
  it('raises NO_INDEX when the seed has nothing to retrieve', async () => {
    await assert.rejects(
      () => chatRetrieve('demo', 'confiar', 5),
      (e) => e instanceof ApiError && e.code === 'NO_INDEX',
    )
  })

  it('returns citation-shaped chunks via BM25 when there is a corpus but no vector index', async () => {
    writeTranscript()
    const res = await chatRetrieve('demo', 'confiar', 5)
    assert.equal(res.mode, 'bm25')
    assert.equal(res.k_used, 5)
    assert.ok(res.retrieved_chunks.length > 0)
    assert.ok(res.retrieved_chunks.every((c) => c.session === 'S001'))
    // at least one whole-utterance chunk resolves its utterance_id
    assert.ok(res.retrieved_chunks.some((c) => c.utterance_id !== null))
  })
})
