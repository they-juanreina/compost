import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import Database from 'better-sqlite3'

import { CompostError } from '../errors.js'
import { eventsToProvO } from '../exporters/prov.js'
import { eventsDbPath } from './events.js'

/**
 * Back up a seed's canonical provenance (#236 readiness follow-up).
 *
 * `.compost/events.sqlite` is the append-only event log every artifact's lineage
 * reduces from — it is NOT rebuildable (snapshots/markdown derive from it, never
 * the reverse), yet it lives inside the per-seed `.compost/`, which is gitignored
 * and excluded from backups-of-tracked-files. Losing it makes every claim
 * unattributable. This produces a portable bundle (a copy of the ledger plus a
 * human-auditable W3C PROV-O JSON-LD serialization) in the seed's `exports/`
 * (which IS tracked/synced), so the provenance can travel with the seed.
 *
 * `verify: true` reads the ledger without writing — a cheap pre-move/pre-backup
 * consistency check (a corrupt db throws here rather than silently producing a
 * bad backup).
 */

export interface BackupOptions {
  /** Output directory. Defaults to `<seed>/exports`. */
  outDir?: string
  /** Read-and-check only; write nothing. */
  verify?: boolean
  /** ISO timestamp for the filenames (injected in tests; defaults to now). */
  now?: () => Date
}

export interface BackupResult {
  seed: string
  events_db: string
  mode: 'backup' | 'verify'
  /** Provenance graph counts — double as the consistency summary. */
  entities: number
  activities: number
  agents: number
  /** Written paths (absent in verify mode). */
  ledger_copy?: string
  provenance?: string
}

export function backupSeed(seedPath: string, opts: BackupOptions = {}): BackupResult {
  const eventsDb = eventsDbPath(seedPath)
  if (!existsSync(eventsDb)) {
    throw new CompostError(
      'FILE_NOT_FOUND',
      `No events.sqlite at ${eventsDb}. Nothing to back up yet — no artifacts have been created in this seed.`,
    )
  }

  // Reading the full event log doubles as a consistency check: a corrupt ledger
  // throws here instead of silently producing a bad backup.
  const prov = eventsToProvO(eventsDb)
  const seedName = basename(seedPath)

  if (opts.verify === true) {
    return {
      seed: seedPath,
      events_db: eventsDb,
      mode: 'verify',
      entities: prov.entities,
      activities: prov.activities,
      agents: prov.agents,
    }
  }

  const outDir = opts.outDir ?? join(seedPath, 'exports')
  mkdirSync(outDir, { recursive: true })
  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')
  const ledgerCopy = join(outDir, `${seedName}-events-${stamp}.sqlite`)
  const provenance = join(outDir, `${seedName}-provenance-${stamp}.jsonld`)
  // A *consistent* snapshot, not a raw byte copy. `copyFileSync` of a live db can
  // tear if `compost watch` is emitting events during the backup, and in WAL mode
  // it omits un-checkpointed frames — exactly the way to corrupt the one ledger
  // this feature exists to protect. `VACUUM INTO` takes a transactional read
  // snapshot into a fresh file; it runs on the read-only connection and never
  // mutates the source. Single-quotes in the path are escaped for the SQL literal.
  const src = new Database(eventsDb, { readonly: true, fileMustExist: true })
  try {
    src.exec(`VACUUM INTO '${ledgerCopy.replace(/'/g, "''")}'`)
  } finally {
    src.close()
  }
  writeFileSync(provenance, JSON.stringify(prov.document, null, 2), 'utf8')

  return {
    seed: seedPath,
    events_db: eventsDb,
    mode: 'backup',
    entities: prov.entities,
    activities: prov.activities,
    agents: prov.agents,
    ledger_copy: ledgerCopy,
    provenance,
  }
}
