import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { rerank } from './rerank.js'
import type { Chunk, ScoredChunk } from './types.js'

function sc(id: string, text: string, score: number): ScoredChunk {
  const meta: Chunk['metadata'] = {
    seed: 'demo',
    session: 'S001',
    speaker_id: null,
    start_ms: null,
    end_ms: null,
    source_page: null,
    highlight_ids: [],
    code_ids: [],
    actor_type: 'agent',
    chunk_type: 'utterance',
  }
  return { id, text, text_sha: id, metadata: meta, score }
}

describe('rerank', () => {
  it('reorders by cross-encoder score and keeps topN', async () => {
    const candidates = [sc('a', 'aaa', 0.9), sc('b', 'bbb', 0.8), sc('c', 'ccc', 0.7)]
    // cross-encoder flips the order: c best, then b, then a
    const ce = (_q: string, passages: string[]) =>
      passages.map((p) => (p === 'ccc' ? 1 : p === 'bbb' ? 0.5 : 0.1))
    const out = await rerank('q', candidates, ce, 2)
    assert.equal(out.length, 2)
    assert.equal(out[0]?.id, 'c')
    assert.equal(out[1]?.id, 'b')
  })

  it('returns [] for no candidates', async () => {
    assert.deepEqual(await rerank('q', [], () => []), [])
  })

  it('throws when the encoder returns a wrong-length score array', async () => {
    await assert.rejects(
      () => rerank('q', [sc('a', 'a', 1)], () => [0.5, 0.6]),
      /returned 2 scores/,
    )
  })
})
