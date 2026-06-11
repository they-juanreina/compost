import { existsSync } from 'node:fs'

import { errMessage } from '../errors.js'
import { emitAgentCreate, openSeedEvents } from '../lib/events.js'
import { JobQueue, MAX_ATTEMPTS, resolveJobSource, stateDbPath } from '../lib/queue.js'
import { writeTranscriptMd } from '../render/transcript_md.js'
import { TranscriberClient, TranscriberServiceError } from '../transcriber_client.js'

const AGENT_NAME = 'transcribe-worker'
const AGENT_VERSION = '0.1.0'

export interface WorkerStepResult {
  processed: number
  results: Array<{ job_id: number; session_id: string; status: string; transcript_path?: string }>
}

export interface WorkerDeps {
  client?: TranscriberClient
  /** Optional per-item progress sink (the watch command wires this to a
   * TTY-gated stderr line in human mode; stdout stays machine-clean). */
  onProgress?: (msg: string) => void
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
      const job = queue.claim('transcribe')
      if (job === null) break
      out.processed += 1
      const sessionId = String(job.payload.session_id ?? 'S?')
      deps.onProgress?.(`transcribing ${sessionId} (this can take minutes)…`)
      try {
        const language = typeof job.payload.language === 'string' ? job.payload.language : undefined
        const resp = await client.transcribe(
          resolveJobSource(seedPath, job.source_path),
          sessionId,
          seedPath,
          language,
        )
        if (resp.status === 'failed_transcription') {
          queue.fail(job.id, 'service reported failed_transcription', MAX_ATTEMPTS)
          out.results.push({
            job_id: job.id,
            session_id: sessionId,
            status: 'failed_transcription',
          })
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
        queue.fail(job.id, errMessage(err), MAX_ATTEMPTS)
        out.results.push({ job_id: job.id, session_id: sessionId, status: 'error' })
        // Stop the drain ONLY on a service-level failure (down / model missing) —
        // then nothing else will succeed this pass. A per-file failure (kind
        // 'failed': corrupt media, bad codec) is specific to this job, so keep
        // draining the rest of the queue instead of stalling them (mirrors
        // legacy_worker.ts). The per-job attempt counter handles transient retries.
        if (
          err instanceof TranscriberServiceError &&
          (err.kind === 'down' || err.kind === 'model_missing')
        ) {
          break
        }
      }
    }
    return out
  } finally {
    queue.close()
    events.close()
  }
}
