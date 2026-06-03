import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseAnthropicCitations, toDocumentBlocks } from './citations_anthropic.js'
import { buildVectorRecords, type IndexableArtifact, LanceDBRetriever } from './lancedb.js'

describe('Anthropic citations (#42)', () => {
  it('formats chunks as document blocks with citations enabled', () => {
    const blocks = toDocumentBlocks([{ utterance_id: 'U-0001', session_id: 'S001', text: 'hola' }])
    assert.equal(blocks[0]?.type, 'document')
    assert.equal(blocks[0]?.citations.enabled, true)
    assert.equal(blocks[0]?.title, 'S001:U-0001')
  })

  it('parses citations[] back into claims with ids', () => {
    const { answer, claims } = parseAnthropicCitations([
      {
        type: 'text',
        text: 'They distrust alerts.',
        citations: [{ cited_text: 'no sé si confiar', document_title: 'S001:U-0001' }],
      },
    ])
    assert.equal(answer, 'They distrust alerts.')
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.utterance_id, 'U-0001')
    assert.equal(claims[0]?.session_id, 'S001')
    assert.equal(claims[0]?.quote, 'no sé si confiar')
  })

  it('ignores citations whose title is not session:U-NNNN', () => {
    const { claims } = parseAnthropicCitations([
      { type: 'text', text: 'x', citations: [{ cited_text: 'q', document_title: 'garbage' }] },
    ])
    assert.equal(claims.length, 0)
  })
})

describe('LanceDB (#43)', () => {
  const artifacts: IndexableArtifact[] = [
    {
      id: 'a',
      kind: 'utterance',
      seed: 'demo',
      session: 'S001',
      text: 'one',
      text_sha: 'sha1',
      vector: [1, 0],
    },
    {
      id: 'b',
      kind: 'utterance',
      seed: 'demo',
      session: 'S001',
      text: 'two',
      text_sha: 'sha2',
      vector: [0, 1],
    },
    {
      id: 'a2',
      kind: 'utterance',
      seed: 'demo',
      session: 'S001',
      text: 'one',
      text_sha: 'sha1',
      vector: [1, 0],
    },
  ]

  it('builds rows idempotently on text_sha (dupes dropped)', () => {
    const rows = buildVectorRecords(artifacts)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.text_sha).sort(), ['sha1', 'sha2'])
    assert.equal(typeof rows[0]?.metadata, 'string')
  })

  it('LanceDBRetriever maps table hits to ScoredChunks (distance → similarity)', async () => {
    const table = {
      async search(_v: number[], _k: number) {
        return [
          {
            id: 'a',
            kind: 'utterance',
            seed: 'demo',
            session: 'S001',
            speaker_id: 'S1',
            start_ms: 0,
            end_ms: 1,
            text: 'one',
            vector: [1, 0],
            metadata: '{}',
            text_sha: 'sha1',
            _distance: 0.1,
          },
        ]
      },
    }
    const retriever = new LanceDBRetriever(table, async () => [1, 0])
    const hits = await retriever.search('q', 5)
    assert.equal(hits[0]?.id, 'a')
    assert.ok(Math.abs((hits[0]?.score ?? 0) - 0.9) < 1e-9)
  })
})
