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
      const job = queue.claim('transcribe')
      if (job === null) break
      out.processed += 1
      const sessionId = String(job.payload.session_id ?? 'S?')
      try {
        const language = typeof job.payload.language === 'string' ? job.payload.language : undefined
        const resp = await client.transcribe(job.source_path, sessionId, seedPath, language)
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
