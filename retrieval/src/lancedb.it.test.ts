import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildVectorRecords, openLanceDBForRead, openLanceDBForWrite } from './lancedb.js'

// Opt-in native-LanceDB integration test for the embed-worker write path (#159).
// The unit tests inject a fake table that skips `createTable`, so a bootstrap
// sentinel the real binary rejects (#157: null at row 0) went unnoticed. This
// exercises the real @lancedb/lancedb binary end to end.
// Run: COMPOST_LANCEDB_IT=1 pnpm --filter @they-juanreina/compost-retrieval test
const enabled = process.env.COMPOST_LANCEDB_IT === '1'
const DIM = 4

test('native LanceDB: write (incl. null speaker/timing) -> reopen -> vector search', {
  skip: enabled ? false : 'set COMPOST_LANCEDB_IT=1 to run against the native binary',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compost-lancedb-it-'))
  try {
    const records = buildVectorRecords([
      {
        id: 'u1',
        kind: 'utterance',
        seed: 's',
        session: 'ses',
        speaker_id: 'spk-a',
        start_ms: 100,
        end_ms: 900,
        text: 'alpha with speaker and timing',
        text_sha: 'sha-1',
        vector: [1, 0, 0, 0],
      },
      {
        // speaker_id / start_ms / end_ms absent -> null columns
        id: 'u2',
        kind: 'legacy_chunk',
        seed: 's',
        session: 'ses',
        text: 'beta without speaker or timing',
        text_sha: 'sha-2',
        vector: [0, 1, 0, 0],
      },
      {
        id: 'u3',
        kind: 'utterance',
        seed: 's',
        session: 'ses',
        speaker_id: null,
        start_ms: null,
        end_ms: null,
        text: 'gamma explicit nulls',
        text_sha: 'sha-3',
        vector: [0, 0, 1, 0],
      },
    ])

    const writer = await openLanceDBForWrite(dir, DIM)
    assert.equal(await writer.upsertByTextSha(records), 3)
    assert.equal(await writer.size(), 3) // sentinel was deleted
    // Idempotent re-run is a no-op.
    assert.equal(await writer.upsertByTextSha(records), 0)

    const retriever = await openLanceDBForRead(dir, async () => [0, 1, 0, 0])
    assert.ok(retriever, 'index should reopen for read')
    const hits = await retriever.search('anything', 3)

    assert.equal(hits.length, 3)
    assert.ok(!hits.some((h) => h.id === '__bootstrap__'))
    assert.equal(hits[0]?.id, 'u2') // nearest to the query vector
    const byId = new Map(hits.map((h) => [h.id, h]))
    assert.equal(byId.get('u1')?.metadata.speaker_id, 'spk-a')
    assert.equal(byId.get('u1')?.metadata.start_ms, 100)
    assert.equal(byId.get('u1')?.metadata.end_ms, 900)
    for (const id of ['u2', 'u3']) {
      const m = byId.get(id)?.metadata
      assert.equal(m?.speaker_id, null, `${id} speaker_id`)
      assert.equal(m?.start_ms, null, `${id} start_ms`)
      assert.equal(m?.end_ms, null, `${id} end_ms`)
    }
    assert.equal(byId.get('u2')?.text, 'beta without speaker or timing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
