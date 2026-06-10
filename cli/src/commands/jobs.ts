import { existsSync } from 'node:fs'

import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { type Job, JobQueue, type JobStatus, resolveJobSource, stateDbPath } from '../lib/queue.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

const STATUSES: JobStatus[] = ['queued', 'running', 'done', 'failed']

interface JobsFlags {
  seed?: string
  status?: string
}

interface RequeueFlags {
  seed?: string
  id?: string
}

/** Public row shape: the queue's Job minus the parsed payload blob, plus the
 * payload fields a human actually triages on. */
function toRow(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    session_id: job.payload.session_id ?? null,
    source_path: job.source_path,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
  }
}

function renderList(d: { jobs: Array<Record<string, unknown>>; counts: Record<string, number> }) {
  if (d.jobs.length === 0) return 'No jobs in the queue.'
  const lines = d.jobs.map((j) => {
    const head = `  #${j.id} [${j.status}] ${j.kind} ${j.session_id ?? ''} (${j.attempts} attempt(s))`
    return j.error === null ? head : `${head}\n      last error: ${j.error}`
  })
  const totals = STATUSES.map((s) => `${s}: ${d.counts[s] ?? 0}`).join('   ')
  return `${lines.join('\n')}\n  ${totals}`
}

export function registerJobs(program: Command): void {
  const jobs = program
    .command('jobs')
    .description("List the seed's ingest job queue (transcribe + legacy-ingest)")
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--status <status>', `Filter by status (${STATUSES.join(', ')})`)
    .action((flags: JobsFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        if (flags.status !== undefined && !STATUSES.includes(flags.status as JobStatus)) {
          throw new CompostError(
            'INVALID_INPUT',
            `--status must be one of ${STATUSES.join(', ')}; got ${JSON.stringify(flags.status)}`,
          )
        }
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const queue = new JobQueue(stateDbPath(seedPath))
        try {
          const rows = queue.list(flags.status as JobStatus | undefined).map(toRow)
          emit(
            { status: 'ok', command: 'jobs', jobs: rows, counts: queue.counts() },
            out,
            renderList,
          )
        } finally {
          queue.close()
        }
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  jobs
    .command('requeue')
    .description(
      'Reset permanently-failed jobs to queued with a fresh attempt budget, then rerun `compost watch --once`',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--id <id>', 'Requeue a single job by id (default: every failed job)')
    .action((flags: RequeueFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const id = flags.id === undefined ? undefined : Number(flags.id)
        if (id !== undefined && (!Number.isInteger(id) || id <= 0)) {
          throw new CompostError(
            'INVALID_INPUT',
            `--id must be a positive integer; got ${JSON.stringify(flags.id)}`,
          )
        }
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const queue = new JobQueue(stateDbPath(seedPath))
        try {
          const requeued = queue.requeue(id)
          // A requeued job whose source vanished (seed moved/renamed by hand)
          // will only burn its fresh attempts — say so up front (#240).
          const warnings = requeued
            .filter((j) => !existsSync(resolveJobSource(seedPath, j.source_path)))
            .map((j) => `job ${j.id}: source no longer exists on disk: ${j.source_path}`)
          emit(
            {
              status: 'ok',
              command: 'jobs requeue',
              requeued: requeued.length,
              job_ids: requeued.map((j) => j.id),
              warnings,
            },
            out,
            (d: { requeued: number; warnings: string[] }) =>
              d.requeued === 0
                ? 'No failed jobs to requeue.'
                : [
                    `Requeued ${d.requeued} job(s). Run \`compost watch --once\` to process them.`,
                    ...d.warnings.map((w) => `  warning: ${w}`),
                  ].join('\n'),
          )
        } finally {
          queue.close()
        }
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
