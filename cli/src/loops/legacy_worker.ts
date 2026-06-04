import { LegacyIngestClient, LegacyServiceError } from '../legacy_client.js'
import { emitAgentCreate, openSeedEvents } from '../lib/events.js'
import { JobQueue, stateDbPath } from '../lib/queue.js'

const AGENT_NAME = 'legacy-ingest-worker'
const AGENT_VERSION = '0.1.0'
const MAX_ATTEMPTS = 3

export interface LegacyWorkerResult {
  processed: number
  results: Array<{
    job_id: number
    source_path: string
    status: string
    normalized_path?: string
    utterance_count?: number
  }>
}

export interface LegacyWorkerDeps {
  client?: LegacyIngestClient
}

/**
 * Drain all queued `legacy-ingest` jobs (PDF/DOCX/PPTX/CSV/MD/TXT/XLSX).
 * Each job is POSTed to the transcriber's /legacy-ingest route, which writes
 * a normalized transcript-shaped JSON under `<seed>/legacy/<basename>.json`.
 *
 * Transient failures (service down) requeue with backoff; permanent failures
 * (invalid input, missing dep) burn the attempt counter so the job moves to
 * failed status after MAX_ATTEMPTS.
 */
export async function runLegacyWorkerOnce(
  seedPath: string,
  deps: LegacyWorkerDeps = {},
): Promise<LegacyWorkerResult> {
  const client = deps.client ?? new LegacyIngestClient()
  const queue = new JobQueue(stateDbPath(seedPath))
  const events = openSeedEvents(seedPath)
  const out: LegacyWorkerResult = { processed: 0, results: [] }

  try {
    while (true) {
      const job = queue.claim('legacy-ingest')
      if (job === null) break
      out.processed += 1
      const sourcePath = job.source_path
      try {
        const resp = await client.ingest({
          seed_path: seedPath,
          source_path: sourcePath,
        })
        queue.complete(job.id)
        emitAgentCreate(events, {
          artifactKind: 'legacy_chunk',
          initialState: {
            source_path: resp.source_path,
            normalized_path: resp.normalized_path,
            utterance_count: resp.utterance_count,
            status: resp.status,
          },
          agentName: AGENT_NAME,
          agentVersion: AGENT_VERSION,
        })
        out.results.push({
          job_id: job.id,
          source_path: sourcePath,
          status: resp.status,
          normalized_path: resp.normalized_path,
          utterance_count: resp.utterance_count,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        queue.fail(job.id, msg, MAX_ATTEMPTS)
        out.results.push({ job_id: job.id, source_path: sourcePath, status: 'error' })
        // On service-down, stop the drain — nothing else will succeed now.
        if (err instanceof LegacyServiceError && err.kind === 'down') break
      }
    }
    return out
  } finally {
    queue.close()
    events.close()
  }
}
