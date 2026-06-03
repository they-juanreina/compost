import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Database } from 'better-sqlite3'

import { ProvenanceError } from '../errors.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const MIGRATION_RE = /^(\d{4})_.+\.sql$/

export function applyMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number
  }>
  const applied = new Set(appliedRows.map((r) => r.version))

  const migrations = listMigrations()

  for (const m of migrations) {
    if (applied.has(m.version)) continue
    const sql = readFileSync(m.path, 'utf8')
    const tx = db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version)
    })
    try {
      tx()
    } catch (cause) {
      throw new ProvenanceError('MIGRATION_FAILED', `Migration ${m.version} (${m.path}) failed`, {
        cause,
      })
    }
  }
}

interface MigrationFile {
  version: number
  path: string
}

function listMigrations(): MigrationFile[] {
  const files = readdirSync(__dirname)
  const out: MigrationFile[] = []
  for (const file of files) {
    const m = MIGRATION_RE.exec(file)
    if (m === null) continue
    out.push({ version: Number(m[1]), path: join(__dirname, file) })
  }
  out.sort((a, b) => a.version - b.version)
  return out
}
