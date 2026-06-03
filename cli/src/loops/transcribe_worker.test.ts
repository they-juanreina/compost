import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { JobQueue, stateDbPath } from '../lib/queue.js'
import { initSeed } from '../lib/seed.js'
import type { TranscribeResponse } from '../transcriber_client.js'
import { TranscriberServiceError } from '../transcriber_client.js'
import { runSupervisorOnce } from './supervisor.js'
import { runTranscribeWorkerOnce } from './transcribe_worker.js'

const SAMPLE_TRANSCRIPT = {
  schema_version: '1.0',
  session_id: 'S001',
  source: 'sessions/S001/source.mp4',
  language: 'es-CO',
  duration_ms: 60000,
  modality: ['audio'],
  speakers: [{ id: 'S1', name: 'Mod', type: 'moderator' }],
  utterances: [
    { id: 'U-0001', speaker_id: 'S1', turn: 1, start_ms: 0, end_ms: 2000, text: 'hola' },
  ],
  silences: [],
  cues: [],
}

// A fake client that writes a transcript.json (as the real service would) and
// returns the given status.
function fakeClient(status: TranscribeResponse['status'], seedPath: string) {
  return {
    async transcribe(_audio: string, sessionId: string): Promise<TranscribeResponse> {
      const dir = join(seedPath, 'sessions', sessionId)
      mkdirSync(dir, { recursive: true })
      const tp = join(dir, 'transcript.json')
      writeFileSync(tp, JSON.stringify({ ...SAMPLE_TRANSCRIPT, session_id: sessionId }))
      return { session_id: sessionId, transcript_path: tp, status }
    },
    async health() {
      return { ok: true, versions: {} }
    },
  }
}

function downClient() {
  return {
    async transcribe(): Promise<TranscribeResponse> {
      throw new TranscriberServiceError('down', 'down')
    },
    async health() {
      return { ok: false, versions: {} }
    },
  }
}

describe('runTranscribeWorkerOnce', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-worker-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('processes a queued transcribe job, writes transcript.md, completes', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const q = new JobQueue(stateDbPath(path))
    q.enqueue('transcribe', join(path, 'sessions/S001/source.mp4'), { session_id: 'S001' })
    q.close()

    // biome-ignore lint/suspicious/noExplicitAny: fake client for test
    const res = await runTranscribeWorkerOnce(path, { client: fakeClient('ok', path) as any })
    assert.equal(res.processed, 1)
    assert.equal(res.results[0]?.status, 'ok')
    assert.ok(existsSync(join(path, 'sessions/S001/transcript.md')))

    const q2 = new JobQueue(stateDbPath(path))
    assert.equal(q2.list('done').length, 1)
    q2.close()
  })

  it('does not process legacy-ingest jobs', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const q = new JobQueue(stateDbPath(path))
    q.enqueue('legacy-ingest', join(path, 'legacy/a.pdf'), {})
    q.close()
    // biome-ignore lint/suspicious/noExplicitAny: fake client for test
    const res = await runTranscribeWorkerOnce(path, { client: fakeClient('ok', path) as any })
    assert.equal(res.processed, 0)
  })

  it('requeues on service-down error (attempt burned, job back to queued)', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const q = new JobQueue(stateDbPath(path))
    q.enqueue('transcribe', join(path, 'sessions/S001/source.mp4'), { session_id: 'S001' })
    q.close()
    // biome-ignore lint/suspicious/noExplicitAny: fake client for test
    const res = await runTranscribeWorkerOnce(path, { client: downClient() as any })
    assert.equal(res.results[0]?.status, 'error')
    const q2 = new JobQueue(stateDbPath(path))
    assert.equal(q2.list('queued').length, 1) // requeued (1st of 3 attempts)
    q2.close()
  })

  it('surfaces needs_speaker_labels status', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const q = new JobQueue(stateDbPath(path))
    q.enqueue('transcribe', join(path, 'sessions/S001/source.mp4'), { session_id: 'S001' })
    q.close()
    const res = await runTranscribeWorkerOnce(path, {
      // biome-ignore lint/suspicious/noExplicitAny: fake client for test
      client: fakeClient('needs_speaker_labels', path) as any,
    })
    assert.equal(res.results[0]?.status, 'needs_speaker_labels')
  })
})

describe('runSupervisorOnce', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-sup-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('drains the inbox then the transcribe queue in one pass', async () => {
    const { path } = initSeed('demo', { cwd: work })
    writeFileSync(join(path, 'sessions/_inbox/clip.mp4'), 'x')
    // biome-ignore lint/suspicious/noExplicitAny: fake client for test
    const result = await runSupervisorOnce(path, { client: fakeClient('ok', path) as any })
    assert.equal(result.inbox.moved, 1)
    assert.equal(result.transcribe.processed, 1)
    assert.ok(existsSync(join(path, '.compost/logs/supervisor.jsonl')))
  })
})
