import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { type LegacyIngestClient, LegacyServiceError } from '../legacy_client.js'
import { JobQueue, stateDbPath } from '../lib/queue.js'
import { initSeed } from '../lib/seed.js'
import { countFailedJobs, isFailedResult, runSupervisorOnce } from './supervisor.js'

describe('isFailedResult', () => {
  it('flags error / failed_transcription, not ok or needs_speaker_labels', () => {
    assert.equal(isFailedResult({ status: 'error' }), true)
    assert.equal(isFailedResult({ status: 'failed_transcription' }), true)
    assert.equal(isFailedResult({ status: 'ok' }), false)
    assert.equal(isFailedResult({ status: 'needs_speaker_labels' }), false)
  })
})

describe('countFailedJobs', () => {
  it('collapses retry rows to distinct failed job_ids', () => {
    // one job, three failed attempts (in-pass retries) → 1 distinct failed job
    assert.equal(
      countFailedJobs([
        { job_id: 1, status: 'error' },
        { job_id: 1, status: 'error' },
        { job_id: 1, status: 'error' },
      ]),
      1,
    )
  })
  it('counts distinct failed jobs, ignoring ok / needs_speaker_labels', () => {
    assert.equal(
      countFailedJobs([
        { job_id: 1, status: 'error' },
        { job_id: 2, status: 'failed_transcription' },
        { job_id: 3, status: 'ok' },
        { job_id: 4, status: 'needs_speaker_labels' },
      ]),
      2,
    )
  })
  it('is 0 for an empty or all-ok set', () => {
    assert.equal(countFailedJobs([]), 0)
    assert.equal(countFailedJobs([{ job_id: 1, status: 'ok' }]), 0)
  })
})

describe('runSupervisorOnce failure accounting (#164)', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-sup-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('a clean pass reports no failures', async () => {
    const { path } = initSeed('demo', { cwd: work })
    const r = await runSupervisorOnce(path, { skipLegacy: true, skipEmbed: true })
    assert.deepEqual(r.failures, [])
    assert.equal(r.transcribe.failed, 0)
    assert.equal(r.legacy.failed, 0)
  })

  it('counts a failed legacy job and surfaces it (not reported as success)', async () => {
    const { path } = initSeed('demo', { cwd: work })
    new JobQueue(stateDbPath(path)).enqueue('legacy-ingest', join(path, 'x.txt'), {
      category: 'markdown',
    })
    const failingClient = {
      ingest: async () => {
        throw new LegacyServiceError('boom', 'failed')
      },
    } as unknown as LegacyIngestClient

    const r = await runSupervisorOnce(path, { skipEmbed: true, legacy: { client: failingClient } })
    // processed counts attempts (retried in-pass), failed counts DISTINCT jobs —
    // so processed > failed proves the collapse actually happened.
    assert.ok(r.legacy.processed > r.legacy.failed, `processed=${r.legacy.processed}`)
    assert.equal(r.legacy.failed, 1) // one distinct failed job
    assert.ok(
      r.failures.some((f) => f === 'legacy: 1 job(s) failed'),
      `failures should surface the failed legacy job; got ${JSON.stringify(r.failures)}`,
    )
    assert.equal(r.transcribe.failed, 0)
  })

  it('a later pass over a dead queue is NOT reported as clean (#239)', async () => {
    const { path } = initSeed('demo', { cwd: work })
    new JobQueue(stateDbPath(path)).enqueue('legacy-ingest', join(path, 'x.txt'), {
      category: 'markdown',
    })
    const failingClient = {
      ingest: async () => {
        throw new LegacyServiceError('boom', 'failed')
      },
    } as unknown as LegacyIngestClient

    // pass 1 burns all attempts in-pass → the job lands in permanent `failed`
    const first = await runSupervisorOnce(path, {
      skipEmbed: true,
      legacy: { client: failingClient },
    })
    assert.equal(first.dead_jobs, 1)

    // pass 2 drains nothing — before #239 this reported ok/failures:[]
    const second = await runSupervisorOnce(path, {
      skipEmbed: true,
      legacy: { client: failingClient },
    })
    assert.equal(second.legacy.processed, 0)
    assert.equal(second.dead_jobs, 1)
    assert.ok(
      second.failures.some((f) => f.includes('permanently failed') && f.includes('jobs requeue')),
      `failures should surface the dead job with the recovery command; got ${JSON.stringify(second.failures)}`,
    )
  })
})
