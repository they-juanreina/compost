import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerWatch(program: Command): void {
  program
    .command('watch')
    .description(
      'Run the filesystem watcher and the harness loops (ingest, transcribe, frames, embed, etc.)',
    )
    .option('--once', 'Drain the queues once and exit instead of looping')
    .action(stubAction({ command: 'watch', issue: 19 }))
}
