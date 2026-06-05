import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { runLive, runSupervisorOnce } from '../loops/supervisor.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface WatchFlags {
  once?: boolean
  seed?: string
  intervalMs?: string
}

export function registerWatch(program: Command): void {
  program
    .command('watch')
    .description('Run the filesystem watcher and harness loops (ingest-watcher, transcribe-worker)')
    .option('--once', 'Drain the queues once and exit instead of looping')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--interval-ms <ms>', 'Poll interval for live mode', '2000')
    .action(async (flags: WatchFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        if (flags.once === true) {
          const result = await runSupervisorOnce(seedPath)
          // A drained-but-failed job is not success (#164): non-ok status + exit 1
          // so scripts/CI can gate, with the failures surfaced inline.
          const ok = result.failures.length === 0
          emit(
            {
              status: ok ? 'ok' : 'completed_with_failures',
              command: 'watch',
              mode: 'once',
              ...result,
            },
            out,
          )
          if (!ok) process.exitCode = 1
          return
        }
        // Live mode: wind down cleanly on Ctrl-C; in-flight is bounded per pass.
        const controller = new AbortController()
        process.on('SIGINT', () => controller.abort())
        process.on('SIGTERM', () => controller.abort())
        process.stderr.write(
          `${JSON.stringify({ status: 'watching', seed: seedPath, interval_ms: Number(flags.intervalMs ?? 2000) })}\n`,
        )
        await runLive(seedPath, {
          intervalMs: Number(flags.intervalMs ?? 2000),
          signal: controller.signal,
          onError: (loop, err) =>
            process.stderr.write(
              `${JSON.stringify({ loop, error: err instanceof Error ? err.message : String(err) })}\n`,
            ),
        })
        emit({ status: 'stopped', command: 'watch' }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
