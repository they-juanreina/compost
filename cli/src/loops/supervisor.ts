import { getLogPath, Logger } from '../logging.js'
import { processInbox } from './ingest_watcher.js'
import { runTranscribeWorkerOnce, type WorkerDeps } from './transcribe_worker.js'

export interface SupervisorResult {
  inbox: { moved: number; unsupported: number }
  transcribe: { processed: number }
}

/** One cooperative pass: drain the inbox, then drain transcribe jobs. */
export async function runSupervisorOnce(
  seedPath: string,
  deps: WorkerDeps = {},
): Promise<SupervisorResult> {
  const logger = loopLogger(seedPath, 'supervisor')
  const inbox = processInbox(seedPath)
  await logger.info('inbox drained', {
    moved: inbox.moved.length,
    unsupported: inbox.unsupported.length,
  })
  const worker = await runTranscribeWorkerOnce(seedPath, deps)
  await logger.info('transcribe drained', { processed: worker.processed })
  return {
    inbox: { moved: inbox.moved.length, unsupported: inbox.unsupported.length },
    transcribe: { processed: worker.processed },
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
