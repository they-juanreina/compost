import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SnapshotStore } from '@they-juanreina/compost-provenance'
import Database from 'better-sqlite3'
import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface ReindexFlags {
  seed?: string
  vectors?: boolean
}

export function registerReindex(program: Command): void {
  program
    .command('reindex')
    .description(
      'Rebuild derived state in .compost/ — caches, event snapshots, and optionally vectors',
    )
    .option('--seed <name>', 'Target seed (defaults to the only seed under ./Seeds)')
    .option('--vectors', 'Also rebuild the LanceDB embeddings index')
    .action((flags: ReindexFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const eventsDb = join(seedPath, '.compost', 'events.sqlite')
        if (!existsSync(eventsDb)) {
          throw new CompostError(
            'FILE_NOT_FOUND',
            `No events.sqlite at ${eventsDb}. Has any artifact been created in this seed?`,
          )
        }

        // Rebuild snapshots from the event log.
        const db = new Database(eventsDb)
        try {
          const store = new SnapshotStore(db)
          const rebuilt = store.rebuildAll()

          const result: {
            status: 'ok'
            command: 'reindex'
            seed: string
            snapshots_rebuilt: number
            vectors_rebuilt: number | null
            note?: string
          } = {
            status: 'ok',
            command: 'reindex',
            seed: seedPath,
            snapshots_rebuilt: rebuilt,
            vectors_rebuilt: null,
          }

          if (flags.vectors === true) {
            // The embed-worker already owns the LanceDB write path and rebuilds
            // the index automatically during `compost watch`. The manual
            // --vectors rebuild from here isn't wired yet, so it reports a clear
            // status instead of pretending to succeed.
            result.note =
              '--vectors is not wired yet; the LanceDB index is rebuilt automatically by `compost watch`'
          }

          emit(result, out)
        } finally {
          db.close()
        }
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
