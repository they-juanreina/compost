import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { dedupeByRegion } from './dedupe.js'
import type { ScoredChunk } from './types.js'

function chunk(
  id: string,
  score: number,
  start_ms: number | null,
  end_ms: number | null,
  session = 'S001',
  chunk_type: ScoredChunk['metadata']['chunk_type'] = 'utterance',
): ScoredChunk {
  return {
    id,
    text: id,
    text_sha: id,
    score,
    metadata: {
      seed: 'demo',
      session,
      speaker_id: null,
      start_ms,
      end_ms,
      source_page: null,
      highlight_ids: [],
      code_ids: [],
      actor_type: 'agent',
      chunk_type,
    },
  }
}

describe('dedupeByRegion (#170)', () => {
  it('drops a later chunk overlapping an already-kept region past the threshold', () => {
    const out = dedupeByRegion([
      chunk('u1', 0.9, 0, 3000), // kept
      chunk('w1', 0.8, 0, 7000, 'S001', 'window'), // overlaps u1 fully of u1's span → dropped
    ])
    assert.deepEqual(
      out.map((c) => c.id),
      ['u1'],
    )
  })

  it('keeps distinct non-overlapping regions', () => {
    const out = dedupeByRegion([
      chunk('u1', 0.9, 0, 3000),
      chunk('u2', 0.8, 4000, 7000), // no overlap with u1
    ])
    assert.deepEqual(
      out.map((c) => c.id),
      ['u1', 'u2'],
    )
  })

  it('keeps the highest-ranked of overlapping chunks (input is rank-ordered)', () => {
    const out = dedupeByRegion([
      chunk('w1', 0.95, 0, 7000, 'S001', 'window'), // ranked first → kept
      chunk('u1', 0.9, 0, 3000), // overlaps w1 by 100% of u1's span → dropped
      chunk('u2', 0.85, 4000, 7000), // overlaps w1 by 100% of u2's span → dropped
    ])
    assert.deepEqual(
      out.map((c) => c.id),
      ['w1'],
    )
  })

  it('does not collapse merely-abutting / lightly-overlapping distinct utterances', () => {
    const out = dedupeByRegion([
      chunk('u1', 0.9, 0, 1000),
      chunk('u2', 0.8, 900, 1900), // overlap 100ms / min span 1000 = 0.1 < 0.5 → kept
    ])
    assert.deepEqual(
      out.map((c) => c.id),
      ['u1', 'u2'],
    )
  })

  it('respects session boundaries (same ms range, different session)', () => {
    const out = dedupeByRegion([chunk('a', 0.9, 0, 3000, 'S001'), chunk('b', 0.8, 0, 3000, 'S002')])
    assert.deepEqual(
      out.map((c) => c.id),
      ['a', 'b'],
    )
  })

  it('never drops non-temporal chunks (null ms range)', () => {
    const out = dedupeByRegion([
      chunk('p1', 0.9, null, null, 'S001', 'page'),
      chunk('p2', 0.8, null, null, 'S001', 'term'),
      chunk('u1', 0.7, 0, 3000),
    ])
    assert.deepEqual(
      out.map((c) => c.id),
      ['p1', 'p2', 'u1'],
    )
  })
})
