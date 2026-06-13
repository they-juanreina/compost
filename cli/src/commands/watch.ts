import type { Command } from 'commander'

import { errMessage, isCompostError } from '../errors.js'
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
    .addHelpText(
      'after',
      '\nExamples:\n  $ compost watch --once          # process the queue once, then exit (CI-friendly)\n  $ compost watch                 # live: keep draining every 2s until Ctrl-C',
    )
    .action(async (flags: WatchFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        // Per-item progress to stderr in human mode at a TTY only; stdout (the
        // machine result) stays clean and the agent/JSON path is unaffected.
        const showProgress = out.human && process.stderr.isTTY === true
        const onProgress = showProgress
          ? (msg: string) => process.stderr.write(`${msg}\n`)
          : undefined
        if (flags.once === true) {
          const result = await runSupervisorOnce(seedPath, onProgress ? { onProgress } : {})
          // A drained-but-failed job (#164) OR a standing dead job (#239) is not
          // success: non-ok status + exit 1 so scripts/CI can gate, with the
          // failures surfaced inline.
          const ok = result.failures.length === 0 && result.dead_jobs === 0
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
        const intervalMs = Number(flags.intervalMs ?? 2000)

        // Track silent failures across passes so a long-lived watch can report a
        // non-zero exit instead of always exiting 0 on Ctrl-C (#164 follow-up).
        let crashedPasses = 0
        let failedJobPasses = 0
        let lastDeadJobs = 0

        if (out.human) {
          process.stderr.write(`watching ${seedPath} every ${intervalMs}ms — Ctrl-C to stop\n`)
        } else {
          process.stderr.write(
            `${JSON.stringify({ status: 'watching', seed: seedPath, interval_ms: intervalMs })}\n`,
          )
        }
        await runLive(seedPath, {
          intervalMs,
          signal: controller.signal,
          ...(onProgress ? { onProgress } : {}),
          onError: (loop, err) => {
            crashedPasses += 1
            const message = errMessage(err)
            if (out.human) process.stderr.write(`loop ${loop} error: ${message}\n`)
            else process.stderr.write(`${JSON.stringify({ loop, error: message })}\n`)
          },
          onPass: (result) => {
            if (result.failures.length > 0) failedJobPasses += 1
            lastDeadJobs = result.dead_jobs
            // Surface drained-but-failed / dead jobs that don't throw, so they
            // aren't only visible via `compost status`/`jobs`. Report each count
            // only when non-zero — an idle pass over a dead queue is "1 dead
            // job(s)", not "1 failure(s), 1 dead job(s)" double-counting the same
            // job (#239 follow-up).
            if (out.human && (result.failures.length > 0 || result.dead_jobs > 0)) {
              const parts: string[] = []
              if (result.failures.length > 0) parts.push(`${result.failures.length} failure(s)`)
              if (result.dead_jobs > 0) parts.push(`${result.dead_jobs} dead job(s)`)
              process.stderr.write(`pass: ${parts.join(', ')} — see \`compost jobs\`\n`)
            }
          },
        })
        const clean = crashedPasses === 0 && failedJobPasses === 0 && lastDeadJobs === 0
        emit(
          {
            status: clean ? 'stopped' : 'stopped_with_failures',
            command: 'watch',
            crashed_passes: crashedPasses,
            failed_job_passes: failedJobPasses,
            dead_jobs: lastDeadJobs,
          },
          out,
          (d: { crashed_passes: number; failed_job_passes: number; dead_jobs: number }) =>
            clean
              ? 'watch stopped — no failures'
              : `watch stopped with failures: ${d.crashed_passes} crashed pass(es), ${d.failed_job_passes} pass(es) with failed jobs, ${d.dead_jobs} dead job(s)`,
        )
        if (!clean) process.exitCode = 1
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
