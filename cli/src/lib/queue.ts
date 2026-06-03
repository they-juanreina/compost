import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'

export type JobKind = 'transcribe' | 'legacy-ingest'
export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

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

  /** Atomically claim the oldest queued job (status → running, attempts++). */
  claim(): Job | null {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1")
        .get() as JobRow | undefined
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

  fail(id: number, error: string, maxAttempts = 3): void {
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

  close(): void {
    this.db.close()
  }
}

export function stateDbPath(seedPath: string): string {
  return join(seedPath, '.compost', 'state.sqlite')
}
