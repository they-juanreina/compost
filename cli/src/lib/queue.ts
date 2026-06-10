import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import Database from 'better-sqlite3'

export type JobKind = 'transcribe' | 'legacy-ingest'
export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

/** Attempts before a job moves to permanent `failed` status. Shared by the
 * workers and surfaced in user-facing messages (`compost jobs requeue`). */
export const MAX_ATTEMPTS = 3

export interface Job {
  id: number
  kind: JobKind
  source_path: string
  payload: Record<string, unknown>
  status: JobStatus
  attempts: number
  created_at: string
  updated_at: string
  error: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  source_path TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'queued',
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  error       TEXT,
  UNIQUE (kind, source_path)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`

interface JobRow {
  id: number
  kind: string
  source_path: string
  payload: string
  status: string
  attempts: number
  created_at: string
  updated_at: string
  error: string | null
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind as JobKind,
    source_path: r.source_path,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    status: r.status as JobStatus,
    attempts: r.attempts,
    created_at: r.created_at,
    updated_at: r.updated_at,
    error: r.error,
  }
}

export interface QueueOptions {
  now?: () => Date
}

export class JobQueue {
  private readonly db: Database.Database
  private readonly now: () => Date

  constructor(dbPath: string, opts: QueueOptions = {}) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.now = opts.now ?? (() => new Date())
  }

  /** Enqueue a job. Idempotent on (kind, source_path): returns the existing
   * job id when already present (resumable folder ingest relies on this). */
  enqueue(
    kind: JobKind,
    sourcePath: string,
    payload: Record<string, unknown> = {},
  ): {
    id: number
    inserted: boolean
  } {
    const ts = this.now().toISOString()
    const existing = this.db
      .prepare('SELECT id FROM jobs WHERE kind = ? AND source_path = ?')
      .get(kind, sourcePath) as { id: number } | undefined
    if (existing !== undefined) return { id: existing.id, inserted: false }
    const info = this.db
      .prepare(
        `INSERT INTO jobs (kind, source_path, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .run(kind, sourcePath, JSON.stringify(payload), ts, ts)
    return { id: Number(info.lastInsertRowid), inserted: true }
  }

  /** Atomically claim the oldest queued job (status → running, attempts++).
   * Pass a kind to claim only jobs of that kind (per-worker draining). */
  claim(kind?: JobKind): Job | null {
    const tx = this.db.transaction(() => {
      const row = (
        kind === undefined
          ? this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get()
          : this.db
              .prepare(
                "SELECT * FROM jobs WHERE status = 'queued' AND kind = ? ORDER BY id LIMIT 1",
              )
              .get(kind)
      ) as JobRow | undefined
      if (row === undefined) return null
      const ts = this.now().toISOString()
      this.db
        .prepare(
          "UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?",
        )
        .run(ts, row.id)
      return rowToJob({ ...row, status: 'running', attempts: row.attempts + 1 })
    })
    return tx()
  }

  complete(id: number): void {
    this.db
      .prepare("UPDATE jobs SET status = 'done', updated_at = ?, error = NULL WHERE id = ?")
      .run(this.now().toISOString(), id)
  }

  fail(id: number, error: string, maxAttempts = MAX_ATTEMPTS): void {
    const row = this.db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(id) as
      | { attempts: number }
      | undefined
    const status = row !== undefined && row.attempts >= maxAttempts ? 'failed' : 'queued'
    this.db
      .prepare('UPDATE jobs SET status = ?, updated_at = ?, error = ? WHERE id = ?')
      .run(status, this.now().toISOString(), error, id)
  }

  list(status?: JobStatus): Job[] {
    const rows = (
      status === undefined
        ? this.db.prepare('SELECT * FROM jobs ORDER BY id').all()
        : this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY id').all(status)
    ) as JobRow[]
    return rows.map(rowToJob)
  }

  counts(): Record<JobStatus, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')
      .all() as Array<{ status: JobStatus; n: number }>
    const out: Record<JobStatus, number> = { queued: 0, running: 0, done: 0, failed: 0 }
    for (const r of rows) out[r.status] = r.n
    return out
  }

  /** Reset permanently-failed jobs to `queued` with a fresh attempt budget.
   * The last error is kept on the row until the retry overwrites it, so
   * `compost jobs` still shows why the job died. Pass an id to requeue one
   * job; omit it to requeue every failed job. Returns the requeued jobs. */
  requeue(id?: number): Job[] {
    const tx = this.db.transaction(() => {
      const rows = (
        id === undefined
          ? this.db.prepare("SELECT * FROM jobs WHERE status = 'failed' ORDER BY id").all()
          : this.db.prepare("SELECT * FROM jobs WHERE status = 'failed' AND id = ?").all(id)
      ) as JobRow[]
      const ts = this.now().toISOString()
      for (const row of rows) {
        this.db
          .prepare("UPDATE jobs SET status = 'queued', attempts = 0, updated_at = ? WHERE id = ?")
          .run(ts, row.id)
      }
      return rows.map((row) => rowToJob({ ...row, status: 'queued', attempts: 0, updated_at: ts }))
    })
    return tx()
  }

  close(): void {
    this.db.close()
  }
}

export function stateDbPath(seedPath: string): string {
  return join(seedPath, '.compost', 'state.sqlite')
}

/**
 * Paths stored in the queue (and event log) are seed-relative whenever the
 * file lives inside the seed, so a study folder moved or renamed in Finder
 * keeps a working queue (#240). Paths outside the seed (`compost ingest
 * ~/elsewhere/file.mp3`) stay absolute — they're machine-pinned either way.
 */
export function toSeedRelative(seedPath: string, p: string): string {
  if (!isAbsolute(p)) return p
  const rel = relative(seedPath, p)
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return p
  return rel
}

/**
 * Resolve a stored source path against the seed root. Relative rows (the
 * current format) just join. Absolute rows are legacy (pre-#240) — when the
 * recorded location no longer exists (the seed was moved), recover by
 * re-rooting the `sessions/…` tail under the current seed; if nothing
 * resolves, return the original so the worker fails with the real path in
 * the error.
 */
export function resolveJobSource(seedPath: string, p: string): string {
  if (!isAbsolute(p)) return join(seedPath, p)
  if (existsSync(p)) return p
  const marker = `${sep}sessions${sep}`
  const at = p.indexOf(marker)
  if (at !== -1) {
    const rerooted = join(seedPath, p.slice(at + 1))
    if (existsSync(rerooted)) return rerooted
  }
  return p
}
