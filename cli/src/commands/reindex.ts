import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerReindex(program: Command): void {
  program
    .command('reindex')
    .description(
      'Rebuild derived state in .compost/ — caches, event snapshots, and optionally vectors',
    )
    .option('--vectors', 'Also rebuild the LanceDB embeddings index')
    .action(stubAction({ command: 'reindex' }))
}
