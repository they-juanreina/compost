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
            // The embed-worker (v0.1-04) owns the LanceDB write path. Until it
            // ships, --vectors is a recognized flag that emits a clear "wait" status
            // instead of pretending to succeed.
            result.note = '--vectors requires the embed-worker (v0.1-04, issue #137); not yet wired'
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
