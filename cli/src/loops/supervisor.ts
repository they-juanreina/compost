import { JobQueue, MAX_ATTEMPTS, stateDbPath } from '../lib/queue.js'
import { getLogPath, Logger } from '../logging.js'
import { type EmbedWorkerDeps, runEmbedWorkerOnce } from './embed_worker.js'
import { processInbox } from './ingest_watcher.js'
import { type LegacyWorkerDeps, runLegacyWorkerOnce } from './legacy_worker.js'
import { runTranscribeWorkerOnce, type WorkerDeps } from './transcribe_worker.js'

export interface SupervisorResult {
  inbox: { moved: number; unsupported: number }
  transcribe: { processed: number; failed: number }
  legacy: { processed: number; failed: number }
  embed: { embedded: number; inserted: number; transcripts_scanned: number }
  /** Jobs that exhausted their attempt budget and sit permanently failed in the
   * queue — nothing will pick them up until `compost jobs requeue` (#239). */
  dead_jobs: number
  /** Human-readable failure summaries; empty when the pass was clean. The watch
   * command turns a non-empty list into a non-ok status + non-zero exit (#164). */
  failures: string[]
}

/** A drained job whose status marks it as failed (vs ok / needs_speaker_labels). */
export function isFailedResult(r: { status: string }): boolean {
  return r.status === 'error' || r.status === 'failed_transcription'
}

/** Count DISTINCT failed jobs. A job retried up to MAX_ATTEMPTS within one pass
 * produces several failed result rows, but it's one failed job — report jobs,
 * not attempts. */
export function countFailedJobs(results: Array<{ job_id: number; status: string }>): number {
  return new Set(results.filter(isFailedResult).map((r) => r.job_id)).size
}

export interface SupervisorDeps extends WorkerDeps {
  legacy?: LegacyWorkerDeps
  embed?: EmbedWorkerDeps
  /** Skip the legacy pass (handy for tests that don't want to touch the legacy service). */
  skipLegacy?: boolean
  /** Disable the embed pass (handy for tests that don't want to touch LanceDB). */
  skipEmbed?: boolean
}

/**
 * One cooperative pass:
 *  1. Drain the inbox into sessions/SXXX/ shells
 *  2. Drain transcribe jobs (audio/video → transcript.json)
 *  3. Drain legacy-ingest jobs (PDF/DOCX/PPTX/CSV/MD/TXT/XLSX → legacy/<basename>.json)
 *  4. Embed any newly-produced transcripts into LanceDB
 *
 * Order matters: embed runs LAST so it sees transcripts the transcribe and
 * legacy passes just wrote. Transcribe and legacy are independent (different
 * job kinds); we serialize them to keep the single Python service from
 * saturating.
 */
export async function runSupervisorOnce(
  seedPath: string,
  deps: SupervisorDeps = {},
): Promise<SupervisorResult> {
  const logger = loopLogger(seedPath, 'supervisor')
  const failures: string[] = []
  const inbox = processInbox(seedPath)
  await logger.info('inbox drained', {
    moved: inbox.moved.length,
    unsupported: inbox.unsupported.length,
  })
  const worker = await runTranscribeWorkerOnce(seedPath, deps)
  const transcribeFailed = countFailedJobs(worker.results)
  if (transcribeFailed > 0) failures.push(`transcribe: ${transcribeFailed} job(s) failed`)
  await logger.info('transcribe drained', { processed: worker.processed, failed: transcribeFailed })

  let legacy = { processed: 0, failed: 0 }
  if (deps.skipLegacy !== true) {
    try {
      const result = await runLegacyWorkerOnce(seedPath, deps.legacy ?? {})
      const failed = countFailedJobs(result.results)
      legacy = { processed: result.processed, failed }
      if (failed > 0) failures.push(`legacy: ${failed} job(s) failed`)
      await logger.info('legacy drained', legacy)
    } catch (err) {
      // The whole legacy pass threw (e.g. service down) — surface it, don't block.
      failures.push(`legacy: ${String(err)}`)
      await logger.error('legacy failed', { error: String(err) })
    }
  }

  let embed = { embedded: 0, inserted: 0, transcripts_scanned: 0 }
  if (deps.skipEmbed !== true) {
    try {
      embed = await runEmbedWorkerOnce(seedPath, {
        ...(deps.embed ?? {}),
        ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
      })
      await logger.info('embed drained', embed)
    } catch (err) {
      // Embed failures must not block ingest/transcribe/legacy progress — surface + continue.
      // Common cause: Ollama not running. Surfaced clearly by `compost-setup` (v0.1-07).
      failures.push(`embed: ${String(err)}`)
      await logger.error('embed failed', { error: String(err) })
    }
  }

  // Given-up jobs (status 'failed' after MAX_ATTEMPTS) are skipped by claim(),
  // so without this a pass over a dead queue reports ok forever (#239).
  const queue = new JobQueue(stateDbPath(seedPath))
  const deadJobs = queue.counts().failed
  queue.close()
  if (deadJobs > 0) {
    failures.push(
      `${deadJobs} job(s) permanently failed after ${MAX_ATTEMPTS} attempts — run \`compost jobs\` to inspect and \`compost jobs requeue\` to retry`,
    )
    await logger.warn('dead jobs in queue', { count: deadJobs })
  }

  return {
    inbox: { moved: inbox.moved.length, unsupported: inbox.unsupported.length },
    transcribe: { processed: worker.processed, failed: transcribeFailed },
    legacy,
    embed,
    dead_jobs: deadJobs,
    failures,
  }
}

function loopLogger(seedPath: string, loop: string): Logger {
  const base = getLogPath(seedPath) // <seed>/.compost/logs/<date>.jsonl
  const perLoop = base.replace(/[^/]+$/, `${loop}.jsonl`)
  return new Logger(perLoop)
}

/** Exponential backoff schedule (ms) for crash recovery, capped at maxAttempts. */
export function backoffSchedule(maxAttempts = 3, baseMs = 500): number[] {
  return Array.from({ length: maxAttempts }, (_, i) => baseMs * 2 ** i)
}

export interface RunLiveOptions extends WorkerDeps {
  intervalMs?: number
  signal?: AbortSignal
  onError?: (loop: string, err: unknown) => void
  /** Called after each completed pass (not on a thrown/crashed pass — that goes
   * to onError). Lets `watch` surface drained-but-failed jobs / dead jobs that
   * complete without throwing, so a long-lived watch can signal silent failure. */
  onPass?: (result: SupervisorResult) => void
}

/**
 * Live supervisor loop. Runs a pass every intervalMs until aborted. A pass that
 * throws is retried with backoff up to 3 times before the loop re-arms on the
 * next tick. (Headless-friendly; `compost watch` wires SIGINT to the signal.)
 */
export async function runLive(seedPath: string, opts: RunLiveOptions = {}): Promise<void> {
  const interval = opts.intervalMs ?? 2000
  const backoff = backoffSchedule()
  while (opts.signal?.aborted !== true) {
    let attempt = 0
    while (true) {
      try {
        const result = await runSupervisorOnce(seedPath, opts)
        opts.onPass?.(result)
        break
      } catch (err) {
        opts.onError?.('supervisor', err)
        if (attempt >= backoff.length) break
        // biome-ignore lint/style/noNonNullAssertion: guard above guarantees attempt is in bounds for backoff
        await sleep(backoff[attempt]!, opts.signal)
        attempt += 1
      }
    }
    await sleep(interval, opts.signal)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })
}
