import { getLogPath, Logger } from '../logging.js'
import { processInbox } from './ingest_watcher.js'
import { type LegacyWorkerDeps, runLegacyWorkerOnce } from './legacy_worker.js'
import { runTranscribeWorkerOnce, type WorkerDeps } from './transcribe_worker.js'

export interface SupervisorResult {
  inbox: { moved: number; unsupported: number }
  transcribe: { processed: number }
  legacy: { processed: number }
}

export interface SupervisorDeps extends WorkerDeps {
  legacy?: LegacyWorkerDeps
  /** Skip the legacy pass (handy for tests that don't want to touch the legacy service). */
  skipLegacy?: boolean
}

/**
 * One cooperative pass:
 *  1. Drain the inbox into sessions/SXXX/ shells
 *  2. Drain transcribe jobs (audio/video → transcript.json)
 *  3. Drain legacy-ingest jobs (PDF/DOCX/PPTX/CSV/MD/TXT/XLSX → legacy/<basename>.json)
 *
 * Order matters: transcribe and legacy are independent (different job kinds),
 * so they can in principle run in parallel, but we serialize to keep the
 * single Python service from saturating.
 */
export async function runSupervisorOnce(
  seedPath: string,
  deps: SupervisorDeps = {},
): Promise<SupervisorResult> {
  const logger = loopLogger(seedPath, 'supervisor')
  const inbox = processInbox(seedPath)
  await logger.info('inbox drained', {
    moved: inbox.moved.length,
    unsupported: inbox.unsupported.length,
  })
  const worker = await runTranscribeWorkerOnce(seedPath, deps)
  await logger.info('transcribe drained', { processed: worker.processed })

  let legacy = { processed: 0 }
  if (deps.skipLegacy !== true) {
    try {
      const result = await runLegacyWorkerOnce(seedPath, deps.legacy ?? {})
      legacy = { processed: result.processed }
      await logger.info('legacy drained', legacy)
    } catch (err) {
      // Legacy failures don't block transcribe progress — log and continue.
      await logger.error('legacy failed', { error: String(err) })
    }
  }

  return {
    inbox: { moved: inbox.moved.length, unsupported: inbox.unsupported.length },
    transcribe: { processed: worker.processed },
    legacy,
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
        await runSupervisorOnce(seedPath, opts)
        break
      } catch (err) {
        opts.onError?.('supervisor', err)
        if (attempt >= backoff.length) break
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
