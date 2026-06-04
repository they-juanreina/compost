import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LanceDBWriter, VectorRecord } from 'compost-retrieval'

import { initSeed } from '../lib/seed.js'
import { runEmbedWorkerOnce } from './embed_worker.js'

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
    assert.deepEqual(result, { embedded: 0, inserted: 0, transcripts_scanned: 0 })
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
})
