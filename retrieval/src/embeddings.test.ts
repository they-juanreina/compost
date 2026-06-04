import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  cosineSimilarity,
  DEFAULT_BATCH_SIZE,
  Embedder,
  MemoryCache,
  textSha,
} from './embeddings.js'

describe('Embedder', () => {
  it('defaults to batch size 32 and the bge-m3 model', () => {
    const e = new Embedder(async (t) => t.map(() => [0]))
    assert.equal(DEFAULT_BATCH_SIZE, 32)
    assert.equal(e.model, 'bge-m3')
  })

  it('returns one vector per input', async () => {
    const e = new Embedder(async (texts) => texts.map((_, i) => [i, i + 1]))
    const r = await e.embed(['a', 'b', 'c'])
    assert.equal(r.vectors.length, 3)
    assert.equal(r.computed, 3)
    assert.equal(r.cache_hits, 0)
  })

  it('serves cache hits by content SHA', async () => {
    const cache = new MemoryCache()
    let calls = 0
    const e = new Embedder(
      async (texts) => {
        calls += 1
        return texts.map(() => [1, 2, 3])
      },
      { cache },
    )
    await e.embed(['hello'])
    const second = await e.embed(['hello', 'world'])
    assert.equal(second.cache_hits, 1) // 'hello' cached
    assert.equal(second.computed, 1) // only 'world' computed
    assert.equal(calls, 2)
  })

  it('batches misses by batchSize', async () => {
    const batches: number[] = []
    const e = new Embedder(
      async (texts) => {
        batches.push(texts.length)
        return texts.map(() => [0])
      },
      { batchSize: 2 },
    )
    await e.embed(['a', 'b', 'c', 'd', 'e'])
    assert.deepEqual(batches, [2, 2, 1])
  })

  it('retries a failing batch with backoff, then succeeds', async () => {
    let attempts = 0
    const e = new Embedder(
      async (texts) => {
        attempts += 1
        if (attempts < 3) throw new Error('ollama down')
        return texts.map(() => [9])
      },
      { sleep: async () => {} },
    )
    const r = await e.embed(['x'])
    assert.equal(r.vectors[0]?.[0], 9)
    assert.equal(attempts, 3)
  })

  it('gives up after maxRetries', async () => {
    const e = new Embedder(
      async () => {
        throw new Error('always down')
      },
      { sleep: async () => {}, maxRetries: 2 },
    )
    await assert.rejects(() => e.embed(['x']), /failed after 2 retries/)
  })
})

describe('textSha + cosineSimilarity', () => {
  it('sha is stable 64-hex', () => {
    assert.match(textSha('hello'), /^[a-f0-9]{64}$/)
    assert.equal(textSha('hello'), textSha('hello'))
  })
  it('cosine of identical vectors is 1, orthogonal is 0', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  })
})
