import { existsSync } from 'node:fs'
import { SnapshotStore } from '@they-juanreina/compost-provenance'
import Database from 'better-sqlite3'
import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { eventsDbPath } from '../lib/events.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { runEmbedWorkerOnce } from '../loops/embed_worker.js'
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
    .option('--vectors', 'Also rebuild the LanceDB embeddings index + backfill code_ids')
    .action(async (flags: ReindexFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const eventsDb = eventsDbPath(seedPath)
        if (!existsSync(eventsDb)) {
          throw new CompostError(
            'FILE_NOT_FOUND',
            `No events.sqlite at ${eventsDb}. Has any artifact been created in this seed?`,
          )
        }

        // Rebuild snapshots from the event log.
        const db = new Database(eventsDb)
        let snapshotsRebuilt: number
        try {
          snapshotsRebuilt = new SnapshotStore(db).rebuildAll()
        } finally {
          db.close()
        }

        // --vectors: re-run the embed worker (idempotent on text_sha — new
        // chunks embedded, unchanged ones skipped) and backfill code_ids /
        // codebook_ids onto already-embedded chunks from current evidence (#275).
        // Needs the embeddings provider; a missing provider surfaces as an error.
        let vectorsInserted: number | null = null
        let backfilled: number | null = null
        if (flags.vectors === true) {
          const r = await runEmbedWorkerOnce(seedPath)
          vectorsInserted = r.inserted
          backfilled = r.backfilled
        }

        emit(
          {
            status: 'ok' as const,
            command: 'reindex' as const,
            seed: seedPath,
            snapshots_rebuilt: snapshotsRebuilt,
            vectors_inserted: vectorsInserted,
            chunks_backfilled: backfilled,
          },
          out,
          (d: {
            snapshots_rebuilt: number
            vectors_inserted: number | null
            chunks_backfilled: number | null
          }) =>
            d.vectors_inserted === null
              ? `reindex: rebuilt ${d.snapshots_rebuilt} snapshot(s).`
              : `reindex: rebuilt ${d.snapshots_rebuilt} snapshot(s); embedded ${d.vectors_inserted} new chunk(s); backfilled code_ids onto ${d.chunks_backfilled} chunk(s).`,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
