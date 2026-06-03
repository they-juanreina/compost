import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerBlame(program: Command): void {
  program
    .command('blame')
    .description('Print the lineage chain (three-actor events) for an artifact')
    .argument('<artifact-id>', 'SHA256 of the artifact')
    .action(stubAction({ command: 'blame', issue: 22 }))
}
