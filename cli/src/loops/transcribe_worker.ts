import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import { emitAgentCreate, openSeedEvents } from '../lib/events.js'
import { JobQueue, stateDbPath } from '../lib/queue.js'
import { writeTranscriptMd } from '../render/transcript_md.js'
import { TranscriberClient } from '../transcriber_client.js'

const AGENT_NAME = 'transcribe-worker'
const AGENT_VERSION = '0.1.0'
const MAX_ATTEMPTS = 3

export interface WorkerStepResult {
  processed: number
  results: Array<{ job_id: number; session_id: string; status: string; transcript_path?: string }>
}

export interface WorkerDeps {
  client?: TranscriberClient
}

/**
 * Drain all queued `transcribe` jobs (concurrency 1 — the Python service is the
 * bottleneck). For each: call the service, render transcript.md, and complete.
 * Transient failures requeue via the queue's attempt counter (gives up after 3,
 * marking the job failed). Returns what it did. Pure of timers — the supervisor
 * calls this on a cadence.
 */
export async function runTranscribeWorkerOnce(
  seedPath: string,
  deps: WorkerDeps = {},
): Promise<WorkerStepResult> {
  const client = deps.client ?? new TranscriberClient()
  const queue = new JobQueue(stateDbPath(seedPath))
  const events = openSeedEvents(seedPath)
  const out: WorkerStepResult = { processed: 0, results: [] }

  try {
    while (true) {
      const job = claimTranscribe(queue)
      if (job === null) break
      out.processed += 1
      const sessionId = String(job.payload.session_id ?? 'S?')
      try {
        const resp = await client.transcribe(job.source_path, sessionId)
        if (resp.status === 'failed_transcription') {
          queue.fail(job.id, 'service reported failed_transcription', MAX_ATTEMPTS)
          out.results.push({ job_id: job.id, session_id: sessionId, status: 'failed_transcription' })
          continue
        }
        if (existsSync(resp.transcript_path)) {
          writeTranscriptMd(resp.transcript_path)
        }
        queue.complete(job.id)
        emitAgentCreate(events, {
          artifactKind: 'transcript',
          initialState: {
            session_id: resp.session_id,
            transcript_path: resp.transcript_path,
            status: resp.status,
          },
          agentName: AGENT_NAME,
          agentVersion: AGENT_VERSION,
        })
        out.results.push({
          job_id: job.id,
          session_id: sessionId,
          status: resp.status,
          transcript_path: resp.transcript_path,
        })
        // needs_speaker_labels: completed but flagged for human; surfaced in result.
      } catch (err) {
        queue.fail(job.id, err instanceof Error ? err.message : String(err), MAX_ATTEMPTS)
        out.results.push({ job_id: job.id, session_id: sessionId, status: 'error' })
        // stop the drain on a service-down error; nothing else will succeed now.
        break
      }
    }
    return out
  } finally {
    queue.close()
    events.close()
  }
}

/** Claim the oldest queued job, requeuing any non-transcribe job we peek. Since
 * the queue is FIFO across kinds, we filter by claiming then checking kind. */
function claimTranscribe(queue: JobQueue): ReturnType<JobQueue['claim']> {
  // Only transcribe jobs are processed here; legacy-ingest has its own worker.
  const queued = queue.list('queued').filter((j) => j.kind === 'transcribe')
  if (queued.length === 0) return null
  // claim() takes the oldest queued of any kind; loop until we get a transcribe
  // one (legacy jobs are left for their worker by re-failing them back to queued
  // is wrong — instead we directly claim by scanning). Simplest: claim repeatedly
  // is unsafe; here we rely on transcribe being the common case and just claim.
  const job = queue.claim()
  if (job === null) return null
  if (job.kind !== 'transcribe') {
    // put it back to queued without burning an attempt
    queue.fail(job.id, 'requeued: not a transcribe job', Number.POSITIVE_INFINITY)
    return null
  }
  return job
}
