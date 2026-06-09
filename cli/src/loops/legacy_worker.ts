import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import {
  LegacyIngestClient,
  type LegacyIngestRequest,
  type LegacyIngestResponse,
  LegacyServiceError,
} from '../legacy_client.js'
import { emitAgentCreate, openSeedEvents } from '../lib/events.js'
import { legacyIngestNative } from '../lib/legacyNative.js'
import { resolveNativeRuntime } from '../lib/nativeRuntime.js'
import { JobQueue, MAX_ATTEMPTS, stateDbPath } from '../lib/queue.js'
import { writeTranscriptMd } from '../render/transcript_md.js'

const AGENT_NAME = 'legacy-ingest-worker'
const AGENT_VERSION = '0.1.0'

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
    transcript_path?: string
    utterance_count?: number
    warnings?: string[]
  }>
}

export interface LinkedDoc {
  /** Final location of the normalized copy under legacy/. */
  normalized_path: string
  /** sessions/<sid>/transcript.json when the doc was linked into its session. */
  transcript_path?: string
  warnings: string[]
}

/**
 * Place a freshly-normalized document where the rest of the pipeline expects
 * it (#246): rename the `legacy/` copy after the researcher's original
 * filename (the inbox move renamed the source to `source.<ext>`, so the
 * service output otherwise collides at `legacy/source.json` for every
 * session), and link it into its session as `transcript.json` so search and
 * embeddings pick it up without the manual `cp` step the wiki used to ask
 * for. Non-inbox jobs (no `S\d+` session id) only get the rename.
 */
export function linkNormalizedDoc(
  seedPath: string,
  payload: { session_id?: unknown; original_name?: unknown },
  normalizedPath: string,
): LinkedDoc {
  const warnings: string[] = []
  let finalNormalized = normalizedPath

  const sid = typeof payload.session_id === 'string' ? payload.session_id : undefined
  const original = typeof payload.original_name === 'string' ? payload.original_name : undefined

  if (original !== undefined && existsSync(normalizedPath)) {
    const stem = basename(original, extname(original)).replace(/[^\w.-]+/g, '_')
    const target = join(
      seedPath,
      'legacy',
      sid !== undefined ? `${sid}-${stem}.json` : `${stem}.json`,
    )
    if (target !== normalizedPath) {
      renameSync(normalizedPath, target)
      finalNormalized = target
    }
  }

  if (sid !== undefined && /^S\d+$/.test(sid) && existsSync(finalNormalized)) {
    const sessionDir = join(seedPath, 'sessions', sid)
    const transcriptPath = join(sessionDir, 'transcript.json')
    if (!existsSync(sessionDir)) {
      warnings.push(`session ${sid} has no directory — normalized doc left in legacy/ only`)
      return { normalized_path: finalNormalized, warnings }
    }
    if (existsSync(transcriptPath)) {
      warnings.push(`session ${sid} already has transcript.json — not overwritten`)
      return { normalized_path: finalNormalized, warnings }
    }
    const doc = JSON.parse(readFileSync(finalNormalized, 'utf8')) as Record<string, unknown>
    // The service derives session_id from the file basename ("DOC-source");
    // the session's real id is what search/status/exports key on.
    doc.session_id = sid
    writeFileSync(transcriptPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    try {
      writeTranscriptMd(transcriptPath)
    } catch (err) {
      warnings.push(`transcript.md render failed: ${err instanceof Error ? err.message : err}`)
    }
    return { normalized_path: finalNormalized, transcript_path: transcriptPath, warnings }
  }

  return { normalized_path: finalNormalized, warnings }
}

/** Ingests one legacy asset and returns the normalized result. The default
 * runner prefers the native path (#184) when a Python venv + transcriber dir
 * resolve, falling back to the Docker /legacy-ingest route otherwise. */
export type LegacyRunner = (req: LegacyIngestRequest) => Promise<LegacyIngestResponse>

export interface LegacyWorkerDeps {
  client?: LegacyIngestClient
  /** Override the ingest runner (tests). */
  runner?: LegacyRunner
}

/** Native-first runner: shell out to `app.legacy_cli` when a native runtime
 * resolves; else POST to the Docker fallback via the client. */
function defaultLegacyRunner(client: LegacyIngestClient): LegacyRunner {
  const native = resolveNativeRuntime()
  if (native !== null) {
    return async (req) =>
      legacyIngestNative(req, { python: native.python, transcriberDir: native.transcriberDir })
  }
  return (req) => client.ingest(req)
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
  // An injected client (tests / explicit Docker) wins. Otherwise, in production,
  // prefer the native path and fall back to the Docker route.
  const runner =
    deps.runner ??
    (deps.client !== undefined
      ? (req: LegacyIngestRequest) => (deps.client as LegacyIngestClient).ingest(req)
      : defaultLegacyRunner(new LegacyIngestClient()))
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
        const resp = await runner(ingestReq)
        const linked = linkNormalizedDoc(seedPath, job.payload, resp.normalized_path)
        queue.complete(job.id)
        emitAgentCreate(events, {
          artifactKind: 'legacy_chunk',
          initialState: {
            source_path: resp.source_path,
            normalized_path: linked.normalized_path,
            transcript_path: linked.transcript_path ?? null,
            utterance_count: resp.utterance_count,
            status: resp.status,
            text_col_resolved: resp.text_col_resolved ?? null,
            sidecar_applied: sidecar !== null,
          },
          agentName: AGENT_NAME,
          agentVersion: AGENT_VERSION,
        })
        const warnings = [...(resp.warnings ?? []), ...linked.warnings]
        out.results.push({
          job_id: job.id,
          source_path: sourcePath,
          status: resp.status,
          normalized_path: linked.normalized_path,
          ...(linked.transcript_path !== undefined
            ? { transcript_path: linked.transcript_path }
            : {}),
          utterance_count: resp.utterance_count,
          ...(warnings.length > 0 ? { warnings } : {}),
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
