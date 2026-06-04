import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { loadSeedCorpus, retrieveChunks } from './retrieve.js'
import { initSeed } from './seed.js'

const TRANSCRIPT = {
  schema_version: '1.0',
  session_id: 'S001',
  source: 'sessions/S001/source.mp4',
  language: 'es-CO',
  duration_ms: 60000,
  modality: ['audio'],
  speakers: [{ id: 'S2', name: 'P07', type: 'participant' }],
  utterances: [
    {
      id: 'U-0001',
      speaker_id: 'S2',
      turn: 1,
      start_ms: 0,
      end_ms: 3000,
      text: 'No sé si confiar en la alerta automática.',
    },
    {
      id: 'U-0002',
      speaker_id: 'S2',
      turn: 2,
      start_ms: 4000,
      end_ms: 7000,
      text: 'Prefiero verificar manualmente antes de actuar.',
    },
  ],
  silences: [],
  cues: [],
}

describe('retrieve', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-retrieve-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  function seedWithSession(): string {
    const { path } = initSeed('demo', { cwd: work })
    const sdir = join(path, 'sessions', 'S001')
    mkdirSync(sdir, { recursive: true })
    writeFileSync(join(sdir, 'transcript.json'), JSON.stringify(TRANSCRIPT))
    return path
  }

  it('loadSeedCorpus builds chunks + evidence from transcripts', () => {
    const path = seedWithSession()
    const corpus = loadSeedCorpus(path)
    assert.ok(corpus.chunks.length > 0)
    assert.equal(corpus.seedName, 'demo')
    // evidence maps each utterance id → {session_id, text}
    assert.equal(corpus.evidence.get('U-0001')?.session_id, 'S001')
    assert.match(corpus.evidence.get('U-0001')?.text ?? '', /confiar/)
  })

  it('loadSeedCorpus is empty for a seed with no sessions', () => {
    const { path } = initSeed('empty', { cwd: work })
    const corpus = loadSeedCorpus(path)
    assert.equal(corpus.chunks.length, 0)
    assert.equal(corpus.evidence.size, 0)
  })

  it('retrieveChunks ranks matching passages above the topK cut', async () => {
    const path = seedWithSession()
    const { retrieved, corpus } = await retrieveChunks(path, 'verificar manualmente', { topK: 3 })
    assert.ok(corpus.chunks.length > 0)
    assert.ok(retrieved.length > 0, 'expected at least one ranked chunk')
    assert.ok(retrieved.length <= 3, 'respects topK')
    // The top hit should contain the queried phrase.
    assert.match(retrieved[0]?.text ?? '', /verificar/)
    // Scores are present and descending.
    for (let i = 1; i < retrieved.length; i++) {
      assert.ok((retrieved[i - 1]?.score ?? 0) >= (retrieved[i]?.score ?? 0))
    }
  })

  it('retrieveChunks returns empty for a seed with no sessions', async () => {
    const { path } = initSeed('empty', { cwd: work })
    const { retrieved, corpus } = await retrieveChunks(path, 'anything', {})
    assert.equal(corpus.chunks.length, 0)
    assert.equal(retrieved.length, 0)
  })

  // #151: reports mode 'bm25' when no dense retriever, 'hybrid' when one is
  // injected — and a dense-only semantic match surfaces a chunk pure BM25
  // (which needs a lexical overlap) would rank lower or miss.
  it('reports mode bm25 with no dense retriever', async () => {
    const path = seedWithSession()
    const { mode } = await retrieveChunks(path, 'verificar', {})
    assert.equal(mode, 'bm25')
  })

  it('fuses an injected dense retriever (mode hybrid) and surfaces a semantic-only hit', async () => {
    const path = seedWithSession()
    // A fake dense retriever that "understands" a paraphrase with zero lexical
    // overlap with the corpus — exactly what BM25 cannot match.
    const dense = {
      async search() {
        return [
          {
            id: 'utterance:dense-hit',
            text: 'No sé si confiar en la alerta automática.',
            text_sha: 'sha-dense',
            score: 0.95,
            metadata: {
              seed: 'demo',
              session: 'S001',
              speaker_id: 'S2',
              start_ms: 0,
              end_ms: 3000,
              source_page: null,
              highlight_ids: [],
              code_ids: [],
              actor_type: 'agent' as const,
              chunk_type: 'utterance' as const,
            },
          },
        ]
      },
    }
    // Query has no lexical overlap with "confiar" — BM25 alone would miss it.
    const { retrieved, mode } = await retrieveChunks(path, 'trustworthiness of warnings', {
      dense,
      topK: 5,
    })
    assert.equal(mode, 'hybrid')
    assert.ok(
      retrieved.some((c) => c.id === 'utterance:dense-hit'),
      'the dense-only semantic hit should appear in the fused results',
    )
  })
})
