import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  type LegacyIngestRequest,
  type LegacyIngestResponse,
  LegacyServiceError,
} from '../legacy_client.js'
import { JobQueue, stateDbPath } from '../lib/queue.js'
import { initSeed } from '../lib/seed.js'
import { linkNormalizedDoc, runLegacyWorkerOnce } from './legacy_worker.js'

/**
 * Fake client. Drives different responses per call to simulate the four
 * scenarios the worker has to handle: success, dep_missing, invalid_input,
 * service-down.
 */
class FakeClient {
  calls: LegacyIngestRequest[] = []
  constructor(private readonly responder: (req: LegacyIngestRequest) => LegacyIngestResponse) {}
  async ingest(req: LegacyIngestRequest): Promise<LegacyIngestResponse> {
    this.calls.push(req)
    return this.responder(req)
  }
}

class ThrowingClient {
  calls: LegacyIngestRequest[] = []
  constructor(private readonly err: LegacyServiceError) {}
  async ingest(req: LegacyIngestRequest): Promise<LegacyIngestResponse> {
    this.calls.push(req)
    throw this.err
  }
}

describe('runLegacyWorkerOnce', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-legacy-worker-'))
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('is a no-op when no legacy jobs are queued', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const client = new FakeClient(() => ({
      source_path: '',
      normalized_path: '',
      utterance_count: 0,
      status: 'ok',
    }))
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const result = await runLegacyWorkerOnce(path, { client: client as any })
    assert.deepEqual(result, { processed: 0, results: [] })
  })

  it('drains a queued CSV job, completes it, emits an agent event', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const src = join(path, 'legacy/fact_utterances.csv')
    writeFileSync(src, 'text\nhello\n')
    const q = new JobQueue(stateDbPath(path))
    q.enqueue('legacy-ingest', src, { category: 'tabular', ext: '.csv' })
    q.close()

    const client = new FakeClient((req) => ({
      source_path: req.source_path,
      normalized_path: `${req.seed_path}/legacy/fact_utterances.json`,
      utterance_count: 1,
      status: 'ok',
    }))
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const result = await runLegacyWorkerOnce(path, { client: client as any })
    assert.equal(result.processed, 1)
    assert.equal(client.calls.length, 1)
    assert.equal(client.calls[0]?.source_path, src)
    assert.equal(result.results[0]?.status, 'ok')

    // Job is now done in the queue.
    const q2 = new JobQueue(stateDbPath(path))
    assert.equal(q2.list('done').length, 1)
    assert.equal(q2.list('queued').length, 0)
    q2.close()
  })

  it('uses an injected runner (the native path) instead of the Docker client (#184)', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const src = join(path, 'legacy/doc.pdf')
    writeFileSync(src, '%PDF-1.4 stub')
    const q = new JobQueue(stateDbPath(path))
    q.enqueue('legacy-ingest', src, { category: 'document', ext: '.pdf' })
    q.close()

    const calls: LegacyIngestRequest[] = []
    const result = await runLegacyWorkerOnce(path, {
      runner: async (req) => {
        calls.push(req)
        return {
          source_path: req.source_path,
          normalized_path: `${req.seed_path}/legacy/doc.json`,
          utterance_count: 2,
          status: 'ok',
        }
      },
    })
    assert.equal(result.processed, 1)
    assert.equal(calls.length, 1)
    assert.equal(result.results[0]?.status, 'ok')
    const q2 = new JobQueue(stateDbPath(path))
    assert.equal(q2.list('done').length, 1)
    q2.close()
  })

  it('does not process transcribe jobs', async () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'), { recursive: true })
    const audio = join(path, 'sessions/S001/source.mp3')
    writeFileSync(audio, '')
    const q = new JobQueue(stateDbPath(path))
    q.enqueue('transcribe', audio, { category: 'audio', ext: '.mp3' })
    q.close()

    const client = new FakeClient(() => {
      throw new Error('legacy worker should not have been called')
    })
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const result = await runLegacyWorkerOnce(path, { client: client as any })
    assert.equal(result.processed, 0)
    assert.equal(client.calls.length, 0)
  })

  it('stops the drain on a service-down error (no point continuing)', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const q = new JobQueue(stateDbPath(path))
    for (const name of ['a.csv', 'b.csv', 'c.csv']) {
      writeFileSync(join(path, 'legacy', name), 'text\nhi\n')
      q.enqueue('legacy-ingest', join(path, 'legacy', name), {
        category: 'tabular',
        ext: '.csv',
      })
    }
    q.close()

    const client = new ThrowingClient(new LegacyServiceError('connection refused', 'down'))
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const result = await runLegacyWorkerOnce(path, { client: client as any })
    // Only the first job was attempted; the rest stay queued.
    assert.equal(result.processed, 1)
    assert.equal(client.calls.length, 1)
  })

  it('requeues on invalid_input until max attempts, then marks failed', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const src = join(path, 'legacy/x.csv')
    writeFileSync(src, '')
    const q = new JobQueue(stateDbPath(path))
    q.enqueue('legacy-ingest', src, { category: 'tabular', ext: '.csv' })
    q.close()

    const client = new ThrowingClient(new LegacyServiceError('no text column', 'invalid_input'))
    for (let i = 0; i < 3; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: fake client
      await runLegacyWorkerOnce(path, { client: client as any })
    }
    const q2 = new JobQueue(stateDbPath(path))
    assert.equal(q2.list('failed').length, 1)
    q2.close()
  })

  // v0.1-02 review feedback: a `<file>.compost.json` sidecar lets a researcher
  // pin column mapping per-file. Worker reads it and passes the values to the
  // route, where they win over server-side auto-detect.
  it('reads <file>.compost.json sidecar and passes its values to the client', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const src = join(path, 'legacy/survey.csv')
    writeFileSync(src, 'Response,Participant\nhi,p1\n')
    writeFileSync(
      `${src}.compost.json`,
      JSON.stringify({ text_col: 'Response', speaker_col: 'Participant' }),
    )
    const q = new JobQueue(stateDbPath(path))
    q.enqueue('legacy-ingest', src, { category: 'tabular', ext: '.csv' })
    q.close()

    const client = new FakeClient((req) => ({
      source_path: req.source_path,
      normalized_path: `${req.seed_path}/legacy/survey.json`,
      utterance_count: 1,
      status: 'ok',
      text_col_resolved: req.text_col ?? null,
    }))
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    await runLegacyWorkerOnce(path, { client: client as any })
    assert.equal(client.calls.length, 1)
    assert.equal(client.calls[0]?.text_col, 'Response')
    assert.equal(client.calls[0]?.speaker_col, 'Participant')
  })

  it('omits sidecar fields when sidecar is missing (server auto-detects)', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const src = join(path, 'legacy/no-sidecar.csv')
    writeFileSync(src, 'transcript\nhi\n')
    const q = new JobQueue(stateDbPath(path))
    q.enqueue('legacy-ingest', src, { category: 'tabular', ext: '.csv' })
    q.close()

    const client = new FakeClient((req) => ({
      source_path: req.source_path,
      normalized_path: `${req.seed_path}/legacy/no-sidecar.json`,
      utterance_count: 1,
      status: 'ok',
      text_col_resolved: 'transcript',
    }))
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    await runLegacyWorkerOnce(path, { client: client as any })
    assert.equal(client.calls.length, 1)
    // No text_col passed → server falls back to auto-detect.
    assert.equal(client.calls[0]?.text_col, undefined)
  })

  it('falls through cleanly when the sidecar is malformed JSON', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const src = join(path, 'legacy/bad-sidecar.csv')
    writeFileSync(src, 'text\nhi\n')
    writeFileSync(`${src}.compost.json`, '{ not valid')
    const q = new JobQueue(stateDbPath(path))
    q.enqueue('legacy-ingest', src, { category: 'tabular', ext: '.csv' })
    q.close()

    const client = new FakeClient((req) => ({
      source_path: req.source_path,
      normalized_path: `${req.seed_path}/legacy/bad-sidecar.json`,
      utterance_count: 1,
      status: 'ok',
    }))
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const result = await runLegacyWorkerOnce(path, { client: client as any })
    // Worker doesn't crash; the malformed sidecar is silently ignored.
    assert.equal(result.processed, 1)
    assert.equal(client.calls[0]?.text_col, undefined)
  })
})

/** Minimal transcript-shaped normalized doc, as the legacy service writes it
 * for an inbox file (session_id derived from the `source` basename). */
function normalizedDocFixture(): Record<string, unknown> {
  return {
    schema_version: '1.0',
    kind: 'session',
    session_id: 'DOC-source',
    source: 'source.pdf',
    language: 'en',
    duration_ms: 0,
    speakers: [{ id: 'S1', name: null, type: 'other' }],
    utterances: [{ speaker_id: 'S1', text: 'hello from the PDF', start_ms: 0, end_ms: 0 }],
    silences: [],
    cues: [],
  }
}

describe('linkNormalizedDoc (#246)', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-legacy-link-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('renames the legacy copy after the original file and links it as the session transcript', () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'), { recursive: true })
    const normalized = join(path, 'legacy/source.json')
    writeFileSync(normalized, JSON.stringify(normalizedDocFixture()))

    const linked = linkNormalizedDoc(
      path,
      { session_id: 'S001', original_name: 'My Interview (final).pdf' },
      normalized,
    )

    assert.equal(linked.normalized_path, join(path, 'legacy/S001-My_Interview_final_.json'))
    assert.ok(existsSync(linked.normalized_path), 'renamed legacy copy exists')
    assert.ok(!existsSync(normalized), 'colliding source.json name is gone')
    assert.equal(linked.transcript_path, join(path, 'sessions/S001/transcript.json'))
    const transcript = JSON.parse(readFileSync(linked.transcript_path ?? '', 'utf8')) as {
      session_id: string
    }
    assert.equal(transcript.session_id, 'S001') // rewritten from "DOC-source"
    assert.ok(existsSync(join(path, 'sessions/S001/transcript.md')), 'human mirror rendered')
    assert.deepEqual(linked.warnings, [])
  })

  it('never overwrites an existing transcript.json (audio already transcribed)', () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'), { recursive: true })
    writeFileSync(join(path, 'sessions/S001/transcript.json'), '{"existing":true}')
    const normalized = join(path, 'legacy/source.json')
    writeFileSync(normalized, JSON.stringify(normalizedDocFixture()))

    const linked = linkNormalizedDoc(
      path,
      { session_id: 'S001', original_name: 'doc.pdf' },
      normalized,
    )

    assert.equal(linked.transcript_path, undefined)
    assert.ok(linked.warnings.some((w) => w.includes('not overwritten')))
    assert.equal(
      readFileSync(join(path, 'sessions/S001/transcript.json'), 'utf8'),
      '{"existing":true}',
    )
  })

  it('only renames for non-inbox jobs (no S-style session id)', () => {
    const { path } = initSeed('demo', { cwd: work })
    const normalized = join(path, 'legacy/source.json')
    writeFileSync(normalized, JSON.stringify(normalizedDocFixture()))

    const linked = linkNormalizedDoc(path, { original_name: 'survey.csv' }, normalized)
    assert.equal(linked.normalized_path, join(path, 'legacy/survey.json'))
    assert.equal(linked.transcript_path, undefined)
  })
})

describe('runLegacyWorkerOnce auto-link', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-legacy-autolink-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('a seed moved after enqueueing still processes (seed-relative rows, #240)', async () => {
    const { path } = initSeed('demo', { cwd: work })
    writeFileSync(join(path, 'sessions/_inbox/report.pdf'), '%PDF-fake')
    const { processInbox } = await import('./ingest_watcher.js')
    processInbox(path)

    // the researcher renames the study folder in Finder
    const moved = join(work, 'Seeds', 'demo-renamed')
    renameSync(path, moved)

    const client = new FakeClient((req) => {
      // the worker must hand the service a live path under the NEW location
      assert.ok(req.source_path.startsWith(moved), req.source_path)
      const normalized = join(req.seed_path, 'legacy/source.json')
      writeFileSync(normalized, JSON.stringify(normalizedDocFixture()))
      return {
        source_path: req.source_path,
        normalized_path: normalized,
        utterance_count: 1,
        status: 'ok',
      }
    })
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const result = await runLegacyWorkerOnce(moved, { client: client as any })
    assert.equal(result.processed, 1)
    assert.equal(result.results[0]?.status, 'ok')
    assert.ok(existsSync(join(moved, 'sessions/S001/transcript.json')))
  })

  it('an inbox document round-trips into its session in one pass', async () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'), { recursive: true })
    const src = join(path, 'sessions/S001/source.pdf')
    writeFileSync(src, '%PDF-fake')
    const q = new JobQueue(stateDbPath(path))
    q.enqueue('legacy-ingest', src, {
      category: 'document',
      session_id: 'S001',
      original_name: 'haraway-interview.pdf',
    })
    q.close()

    const client = new FakeClient((req) => {
      const normalized = join(req.seed_path, 'legacy/source.json')
      writeFileSync(normalized, JSON.stringify(normalizedDocFixture()))
      return {
        source_path: req.source_path,
        normalized_path: normalized,
        utterance_count: 1,
        status: 'ok',
      }
    })
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const result = await runLegacyWorkerOnce(path, { client: client as any })

    assert.equal(result.processed, 1)
    const r = result.results[0]
    assert.ok(r)
    assert.equal(r.status, 'ok')
    assert.equal(r.transcript_path, join(path, 'sessions/S001/transcript.json'))
    assert.equal(r.normalized_path, join(path, 'legacy/S001-haraway-interview.json'))
    assert.ok(existsSync(join(path, 'sessions/S001/transcript.json')))
  })
})
