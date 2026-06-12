import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BM25Index, tokenize } from './bm25.js'
import { HybridRetriever } from './hybrid.js'
import { reciprocalRankFusion } from './rrf.js'
import type { Chunk, ScoredChunk } from './types.js'

function chunk(id: string, text: string, extra: Partial<Chunk['metadata']> = {}): Chunk {
  return {
    id,
    text,
    text_sha: id,
    metadata: {
      seed: 'demo',
      session: 'S001',
      speaker_id: 'S1',
      start_ms: 0,
      end_ms: 1000,
      source_page: null,
      highlight_ids: [],
      code_ids: [],
      actor_type: 'agent',
      chunk_type: 'utterance',
      ...extra,
    },
  }
}

describe('tokenize + BM25', () => {
  it('tokenizes, lowercases, strips punctuation', () => {
    assert.deepEqual(tokenize('¿Confías, de verdad?'), ['confías', 'de', 'verdad'])
  })

  it('ranks the chunk containing query terms first', () => {
    const idx = new BM25Index()
    idx.addAll([
      chunk('c1', 'the alert system is reliable'),
      chunk('c2', 'I distrust the automated alert when it fires'),
      chunk('c3', 'lunch was good'),
    ])
    const hits = idx.search('distrust alert', 10)
    assert.equal(hits[0]?.id, 'c2')
    assert.ok(!hits.some((h) => h.id === 'c3'))
  })

  it('catches a rare acronym (idf weighting)', () => {
    const idx = new BM25Index()
    idx.addAll([chunk('c1', 'the KYC check failed'), chunk('c2', 'the the the the the')])
    const hits = idx.search('KYC', 10)
    assert.equal(hits[0]?.id, 'c1')
  })
})

describe('reciprocalRankFusion', () => {
  it('merges lists and rewards items ranked high in both', () => {
    const lex: ScoredChunk[] = [
      { ...chunk('a', 'a'), score: 9 },
      { ...chunk('b', 'b'), score: 8 },
    ]
    const dense: ScoredChunk[] = [
      { ...chunk('b', 'b'), score: 0.9 },
      { ...chunk('c', 'c'), score: 0.8 },
    ]
    const fused = reciprocalRankFusion([lex, dense], 60, 10)
    // b appears in both → should rank first
    assert.equal(fused[0]?.id, 'b')
  })
})

describe('HybridRetriever', () => {
  function fixtureIndex(): BM25Index {
    const idx = new BM25Index()
    idx.addAll([
      chunk('c1', 'I distrust the alert', { speaker_id: 'S2' }),
      chunk('c2', 'the alert is fine', { speaker_id: 'S1' }),
      chunk('c3', 'unrelated', { speaker_id: 'S1', actor_type: 'ai' }),
    ])
    return idx
  }

  it('retrieves via BM25 alone when no dense retriever', async () => {
    const r = new HybridRetriever(fixtureIndex())
    const hits = await r.retrieve('distrust alert')
    assert.equal(hits[0]?.id, 'c1')
  })

  it('applies speaker_id filters', async () => {
    const r = new HybridRetriever(fixtureIndex())
    const hits = await r.retrieve('alert', { filters: { speaker_id: ['S2'] } })
    assert.ok(hits.every((h) => h.metadata.speaker_id === 'S2'))
  })

  it('applies actor_type filters', async () => {
    const r = new HybridRetriever(fixtureIndex())
    const hits = await r.retrieve('unrelated', { filters: { actor_type: ['researcher', 'agent'] } })
    assert.ok(hits.every((h) => h.metadata.actor_type !== 'ai'))
  })

  it('applies source author filters (#270)', async () => {
    const idx = new BM25Index()
    idx.addAll([
      chunk('h1', 'a situated claim about worlds', {
        attribution: { author: 'Donna Haraway', year: '2007' },
      }),
      chunk('r1', 'a coded interview utterance', {}), // recording, no attribution
    ])
    const r = new HybridRetriever(idx)
    const hits = await r.retrieve('claim utterance', { filters: { author: ['Donna Haraway'] } })
    assert.ok(hits.length > 0)
    assert.ok(hits.every((h) => h.metadata.attribution?.author === 'Donna Haraway'))
    assert.ok(!hits.some((h) => h.id === 'r1')) // un-attributed chunk filtered out
  })

  it('fuses dense results when a dense retriever is supplied', async () => {
    const idx = fixtureIndex()
    const dense = {
      search(): ScoredChunk[] {
        return [{ ...chunk('c2', 'the alert is fine', { speaker_id: 'S1' }), score: 0.99 }]
      },
    }
    const r = new HybridRetriever(idx, dense)
    const hits = await r.retrieve('alert')
    assert.ok(hits.some((h) => h.id === 'c2'))
  })
})
