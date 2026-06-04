import { existsSync, readFileSync } from 'node:fs'

import {
  LegacyIngestClient,
  type LegacyIngestRequest,
  LegacyServiceError,
} from '../legacy_client.js'
import { emitAgentCreate, openSeedEvents } from '../lib/events.js'
import { JobQueue, stateDbPath } from '../lib/queue.js'

const AGENT_NAME = 'legacy-ingest-worker'
const AGENT_VERSION = '0.1.0'
const MAX_ATTEMPTS = 3

/**
 * Optional per-file sidecar: `<source_path>.compost.json` next to the CSV/XLSX
 * lets the researcher pin column mapping that survives re-ingest. Wins over
 * server-side auto-detect.
 *
 * Shape: `{ text_col?: string, speaker_col?: string, sheet?: string }`
 *
 * Example: drop `survey.csv.compost.json` with `{"text_col":"Response"}`
 * next to a CSV whose text column isn't auto-detectable.
 */
interface CompostSidecar {
  text_col?: string
  speaker_col?: string
  sheet?: string
}

function readSidecar(sourcePath: string): CompostSidecar | null {
  const sidecarPath = `${sourcePath}.compost.json`
  if (!existsSync(sidecarPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const out: CompostSidecar = {}
    const r = parsed as Record<string, unknown>
    if (typeof r.text_col === 'string') out.text_col = r.text_col
    if (typeof r.speaker_col === 'string') out.speaker_col = r.speaker_col
    if (typeof r.sheet === 'string') out.sheet = r.sheet
    return out
  } catch {
    // Malformed sidecar — silently fall through to server-side auto-detect.
    // The researcher's intent is unclear; we don't want to block the ingest.
    return null
  }
}

export interface LegacyWorkerResult {
  processed: number
  results: Array<{
    job_id: number
    source_path: string
    status: string
    normalized_path?: string
    utterance_count?: number
    warnings?: string[]
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
        const sidecar = readSidecar(sourcePath)
        const ingestReq: LegacyIngestRequest = {
          seed_path: seedPath,
          source_path: sourcePath,
          ...(sidecar?.text_col !== undefined ? { text_col: sidecar.text_col } : {}),
          ...(sidecar?.speaker_col !== undefined ? { speaker_col: sidecar.speaker_col } : {}),
          ...(sidecar?.sheet !== undefined ? { sheet: sidecar.sheet } : {}),
        }
        const resp = await client.ingest(ingestReq)
        queue.complete(job.id)
        emitAgentCreate(events, {
          artifactKind: 'legacy_chunk',
          initialState: {
            source_path: resp.source_path,
            normalized_path: resp.normalized_path,
            utterance_count: resp.utterance_count,
            status: resp.status,
            text_col_resolved: resp.text_col_resolved ?? null,
            sidecar_applied: sidecar !== null,
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
          ...(resp.warnings && resp.warnings.length > 0 ? { warnings: resp.warnings } : {}),
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
