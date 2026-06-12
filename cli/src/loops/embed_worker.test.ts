import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LanceDBWriter, VectorRecord } from '@they-juanreina/compost-retrieval'

import { createHighlight } from '../lib/artifacts.js'
import { initSeed } from '../lib/seed.js'
import { runEmbedWorkerOnce, runHighlightEmbedWorkerOnce } from './embed_worker.js'

const MINI_TRANSCRIPT = {
  schema_version: '1.0',
  session_id: 'S001',
  source: 'sessions/S001/source.mp3',
  language: 'en',
  duration_ms: 5000,
  modality: ['audio'],
  speakers: [{ id: 'S1', type: 'moderator' }],
  utterances: [
    {
      id: 'U-0001',
      speaker_id: 'S1',
      turn: 1,
      start_ms: 0,
      end_ms: 1000,
      text: 'What do you do when an alert fires?',
    },
    {
      id: 'U-0002',
      speaker_id: 'S1',
      turn: 2,
      start_ms: 1500,
      end_ms: 3000,
      text: 'I never trust them blindly.',
    },
  ],
  silences: [],
  cues: [],
  frames: [],
  glossary_refs: [],
  provenance: { transcriber: 'test' },
}

/** Fake LanceDB writer that records every upsert in-memory. */
class FakeWriter {
  inserted: VectorRecord[] = []
  async upsertByTextSha(records: VectorRecord[]): Promise<number> {
    const seen = new Set(this.inserted.map((r) => r.text_sha))
    const fresh = records.filter((r) => !seen.has(r.text_sha))
    this.inserted.push(...fresh)
    return fresh.length
  }
  async updateChunkMetadata(): Promise<number> {
    return 0 // no codes/highlights in these fixtures → backfill is a no-op
  }
  async size(): Promise<number> {
    return this.inserted.length
  }
}

describe('runEmbedWorkerOnce', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-embed-'))
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('is a no-op when no transcripts exist', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const writer = new FakeWriter()
    const result = await runEmbedWorkerOnce(path, {
      writer: writer as unknown as LanceDBWriter,
      embed: async () => [],
    })
    assert.deepEqual(result, { embedded: 0, inserted: 0, transcripts_scanned: 0, backfilled: 0 })
    assert.equal(writer.inserted.length, 0)
  })

  it('chunks every transcript, embeds once, writes to LanceDB', async () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'), { recursive: true })
    writeFileSync(join(path, 'sessions/S001/transcript.json'), JSON.stringify(MINI_TRANSCRIPT))

    let embedCalls = 0
    let chunkCount = 0
    const embed = async (texts: string[]) => {
      embedCalls += 1
      chunkCount = texts.length
      // Return a deterministic 4-dim vector per text — just a tiny fingerprint.
      return texts.map((_, i) => [1, 0, 0, i])
    }
    const writer = new FakeWriter()

    const result = await runEmbedWorkerOnce(path, {
      writer: writer as unknown as LanceDBWriter,
      embed,
      vectorDim: 4,
    })

    assert.equal(embedCalls, 1, 'embed called once for the whole batch')
    assert.ok(result.embedded > 0, 'produced at least one chunk')
    assert.equal(result.embedded, chunkCount, 'embed input == chunk count')
    assert.equal(result.inserted, result.embedded, 'all chunks inserted on first run')
    assert.equal(result.transcripts_scanned, 1)
    assert.equal(writer.inserted.length, result.inserted)
    // every record has the expected shape
    for (const r of writer.inserted) {
      assert.equal(r.seed, 'demo')
      assert.equal(r.session, 'S001')
      assert.ok(r.vector.length === 4)
      assert.ok(r.text_sha.length > 0)
    }
  })

  it('is idempotent: re-running over identical content inserts zero new rows', async () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'), { recursive: true })
    writeFileSync(join(path, 'sessions/S001/transcript.json'), JSON.stringify(MINI_TRANSCRIPT))

    const writer = new FakeWriter()
    const embed = async (texts: string[]) => texts.map(() => [0, 0, 0, 0])
    const opts = {
      writer: writer as unknown as LanceDBWriter,
      embed,
      vectorDim: 4,
    }
    const first = await runEmbedWorkerOnce(path, opts)
    const second = await runEmbedWorkerOnce(path, opts)
    assert.ok(first.inserted > 0)
    assert.equal(second.inserted, 0, 'second pass inserts nothing')
    // writer rows count stays at first.inserted
    assert.equal(writer.inserted.length, first.inserted)
  })

  it('walks multiple session subdirs and aggregates chunks', async () => {
    const { path } = initSeed('demo', { cwd: work })
    for (const sid of ['S001', 'S002', 'S003']) {
      mkdirSync(join(path, 'sessions', sid), { recursive: true })
      writeFileSync(
        join(path, 'sessions', sid, 'transcript.json'),
        JSON.stringify({ ...MINI_TRANSCRIPT, session_id: sid }),
      )
    }
    const writer = new FakeWriter()
    const result = await runEmbedWorkerOnce(path, {
      writer: writer as unknown as LanceDBWriter,
      embed: async (texts) => texts.map(() => [0, 0, 0, 0]),
      vectorDim: 4,
    })
    assert.equal(result.transcripts_scanned, 3)
    assert.ok(result.embedded >= 3, 'at least one utterance chunk per session')
  })

  it('errors when the embeddings provider returns a mismatched count', async () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'), { recursive: true })
    writeFileSync(join(path, 'sessions/S001/transcript.json'), JSON.stringify(MINI_TRANSCRIPT))

    const writer = new FakeWriter()
    await assert.rejects(
      runEmbedWorkerOnce(path, {
        writer: writer as unknown as LanceDBWriter,
        embed: async () => [[1, 0, 0, 0]], // 1 vector for >1 chunk
        vectorDim: 4,
      }),
      /returned 1 vectors for/,
    )
  })

  // v0.1-04 review feedback: a very large corpus splits into multiple
  // embed() calls of size <= EMBED_BATCH_CAP (defense in depth against
  // multi-megabyte single requests).
  it('splits very large corpora into EMBED_BATCH_CAP-sized passes', async () => {
    const { path } = initSeed('demo', { cwd: work })
    // 200 sessions × ~3 chunks each > 500 chunks (crosses the cap).
    for (let i = 0; i < 200; i++) {
      const sid = `S${String(i + 1).padStart(3, '0')}`
      mkdirSync(join(path, 'sessions', sid), { recursive: true })
      writeFileSync(
        join(path, 'sessions', sid, 'transcript.json'),
        JSON.stringify({ ...MINI_TRANSCRIPT, session_id: sid }),
      )
    }

    let embedCalls = 0
    const batchSizes: number[] = []
    const embed = async (texts: string[]) => {
      embedCalls += 1
      batchSizes.push(texts.length)
      return texts.map(() => [0, 0, 0, 0])
    }
    const writer = new FakeWriter()
    const result = await runEmbedWorkerOnce(path, {
      writer: writer as unknown as LanceDBWriter,
      embed,
      vectorDim: 4,
    })
    assert.ok(result.embedded > 500, `expected >500 chunks, got ${result.embedded}`)
    assert.ok(embedCalls >= 2, `expected >=2 batches, got ${embedCalls}`)
    assert.ok(
      batchSizes.every((s) => s <= 500),
      `some batch exceeded 500: ${batchSizes.join(',')}`,
    )
    // Note: writer.inserted.length tracks dedup-filtered count, not raw chunk count.
    // The MINI_TRANSCRIPT body is identical per session so most chunks dedupe to
    // their first occurrence. We assert only that inserts happened, not the count.
    assert.ok(result.inserted > 0)
  })
})

describe('runHighlightEmbedWorkerOnce (#262)', () => {
  let work: string
  // Deterministic stand-in embedder: a fixed 4-dim vector per call, no network.
  const embed = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4])

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-hl-embed-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  function sidecarPath(seedPath: string, id: string): string {
    return join(seedPath, 'highlights', `${id}.json`)
  }

  it('writes a {id, vector, text_sha} sidecar in the shape the scanner reads', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const hl = createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-0001',
      span: [0, 5],
      text: 'I never trust them blindly.',
      author: { actorType: 'researcher', actorId: 'juan@x' },
    })

    const res = await runHighlightEmbedWorkerOnce(path, { embed, vectorDim: 4 })
    assert.equal(res.highlights_scanned, 1)
    assert.equal(res.embedded, 1)
    assert.equal(res.skipped, 0)

    const sidecar = JSON.parse(readFileSync(sidecarPath(path, hl.id), 'utf8')) as {
      id: string
      vector: number[]
      text_sha: string
    }
    // The scanner's loadEmbeddedHighlights reads exactly {id, vector}.
    assert.equal(sidecar.id, 'H-001')
    assert.deepEqual(sidecar.vector, [0.1, 0.2, 0.3, 0.4])
    assert.equal(typeof sidecar.text_sha, 'string')
  })

  it('is idempotent on text_sha: a second pass re-embeds nothing', async () => {
    const { path } = initSeed('demo', { cwd: work })
    createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-0001',
      span: [0, 5],
      text: 'hello',
      author: { actorType: 'researcher', actorId: 'juan@x' },
    })
    const first = await runHighlightEmbedWorkerOnce(path, { embed, vectorDim: 4 })
    assert.equal(first.embedded, 1)

    let calls = 0
    const countingEmbed = async (texts: string[]) => {
      calls += 1
      return texts.map(() => [0.1, 0.2, 0.3, 0.4])
    }
    const second = await runHighlightEmbedWorkerOnce(path, { embed: countingEmbed, vectorDim: 4 })
    assert.equal(second.embedded, 0)
    assert.equal(second.skipped, 1)
    assert.equal(calls, 0, 'embedder must not be called when nothing is stale')
  })

  it('re-embeds when a highlight body changes (stale sidecar)', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const hl = createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-0001',
      span: [0, 5],
      text: 'original',
      author: { actorType: 'researcher', actorId: 'juan@x' },
    })
    await runHighlightEmbedWorkerOnce(path, { embed, vectorDim: 4 })

    // Rewrite the highlight markdown body (frontmatter kept, text changed).
    const md = readFileSync(hl.path, 'utf8').replace('original', 'edited text')
    writeFileSync(hl.path, md, 'utf8')

    const res = await runHighlightEmbedWorkerOnce(path, { embed, vectorDim: 4 })
    assert.equal(res.embedded, 1, 'changed body must re-embed')
  })

  it('embeds a highlight whose .md has CRLF line endings (externally edited)', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const hl = createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-0001',
      span: [0, 5],
      text: 'situated knowledge',
      author: { actorType: 'researcher', actorId: 'juan@x' },
    })
    // Simulate a Windows editor / core.autocrlf rewriting the file to CRLF.
    writeFileSync(hl.path, readFileSync(hl.path, 'utf8').replace(/\n/g, '\r\n'), 'utf8')

    const res = await runHighlightEmbedWorkerOnce(path, { embed, vectorDim: 4 })
    assert.equal(res.embedded, 1, 'CRLF highlight must still be parsed and embedded')
    assert.ok(existsSync(sidecarPath(path, hl.id)))
  })

  it('no highlights dir / no highlights → zero work, no throw', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const res = await runHighlightEmbedWorkerOnce(path, { embed, vectorDim: 4 })
    assert.deepEqual(res, { highlights_scanned: 0, embedded: 0, skipped: 0 })
    assert.ok(!existsSync(sidecarPath(path, 'H-001')))
  })
})
