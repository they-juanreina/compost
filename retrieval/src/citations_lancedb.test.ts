import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseAnthropicCitations, toDocumentBlocks } from './citations_anthropic.js'
import {
  buildVectorRecords,
  type IndexableArtifact,
  LanceDBRetriever,
  LanceDBWriter,
  type LanceWritableTable,
  type VectorRecord,
} from './lancedb.js'

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

// A stateful fake of the lancedb writable surface, keyed by id. Enough to
// exercise the metadata-update read-modify-write without the native binary.
class FakeWritableTable implements LanceWritableTable {
  rows = new Map<string, VectorRecord>()
  constructor(seed: VectorRecord[] = []) {
    for (const r of seed) this.rows.set(r.id, r)
  }
  async add(rows: VectorRecord[]): Promise<void> {
    for (const r of rows) this.rows.set(r.id, r)
  }
  async countRows(): Promise<number> {
    return this.rows.size
  }
  // Minimal predicate support: `id = '<x>'` (the only shape the writer emits).
  private match(predicate?: string): VectorRecord[] {
    if (predicate === undefined) return [...this.rows.values()]
    const m = /id = '(.*)'/.exec(predicate)
    if (m === null) return []
    const id = (m[1] ?? '').replace(/''/g, "'")
    const row = this.rows.get(id)
    return row !== undefined ? [row] : []
  }
  query() {
    const self = this
    const build = (predicate?: string) => ({
      where: (p: string) => build(p),
      select: (_cols: string[]) => ({
        async toArray() {
          return self.match(predicate).map((r) => ({ ...r }) as Record<string, unknown>)
        },
      }),
    })
    return build()
  }
  async update(opts: { where: string; values: Record<string, unknown> }): Promise<void> {
    for (const r of this.match(opts.where)) {
      this.rows.set(r.id, { ...r, ...opts.values } as VectorRecord)
    }
  }
}

function row(id: string, metadata: Record<string, unknown>): VectorRecord {
  return {
    id,
    kind: 'utterance',
    seed: 'demo',
    session: 'S001',
    speaker_id: null,
    start_ms: null,
    end_ms: null,
    text: id,
    vector: [1, 0],
    metadata: JSON.stringify(metadata),
    text_sha: `sha-${id}`,
  }
}

describe('LanceDBWriter.updateChunkMetadata (#275)', () => {
  it('backfills code_ids + codebook_id onto an existing chunk by id', async () => {
    const table = new FakeWritableTable([row('utterance:abc', { session: 'S001', code_ids: [] })])
    const writer = new LanceDBWriter(table)
    const n = await writer.updateChunkMetadata([
      { id: 'utterance:abc', code_ids: ['C-distrust', 'C-control'], codebook_id: 'CB-primary' },
    ])
    assert.equal(n, 1)
    const meta = JSON.parse(table.rows.get('utterance:abc')?.metadata ?? '{}')
    assert.deepEqual(meta.code_ids, ['C-distrust', 'C-control'])
    assert.equal(meta.codebook_id, 'CB-primary')
    assert.equal(meta.session, 'S001') // untouched fields preserved
  })

  it('REPLACES code_ids (recompute shrinks, not unions)', async () => {
    const table = new FakeWritableTable([
      row('utterance:x', { code_ids: ['C-stale-a', 'C-stale-b'] }),
    ])
    const writer = new LanceDBWriter(table)
    await writer.updateChunkMetadata([{ id: 'utterance:x', code_ids: ['C-kept'] }])
    const meta = JSON.parse(table.rows.get('utterance:x')?.metadata ?? '{}')
    assert.deepEqual(meta.code_ids, ['C-kept'])
  })

  it('skips ids not in the table and empty patches', async () => {
    const table = new FakeWritableTable([row('utterance:x', { code_ids: [] })])
    const writer = new LanceDBWriter(table)
    const n = await writer.updateChunkMetadata([
      { id: 'utterance:missing', code_ids: ['C-a'] }, // no such row
      { id: 'utterance:x' }, // no fields to set
    ])
    assert.equal(n, 0)
    assert.deepEqual(JSON.parse(table.rows.get('utterance:x')?.metadata ?? '{}').code_ids, [])
  })

  it('only updates the targeted row, leaving siblings untouched', async () => {
    const table = new FakeWritableTable([
      row('utterance:a', { code_ids: [] }),
      row('utterance:b', { code_ids: [] }),
    ])
    const writer = new LanceDBWriter(table)
    await writer.updateChunkMetadata([{ id: 'utterance:a', code_ids: ['C-a'] }])
    assert.deepEqual(JSON.parse(table.rows.get('utterance:a')?.metadata ?? '{}').code_ids, ['C-a'])
    assert.deepEqual(JSON.parse(table.rows.get('utterance:b')?.metadata ?? '{}').code_ids, [])
  })
})
