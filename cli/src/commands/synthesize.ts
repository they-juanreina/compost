import type { Command } from 'commander'

import { stubAction, stubDescription } from './_stub.js'

export function registerSynthesize(program: Command): void {
  program
    .command('synthesize')
    .description(
      stubDescription('Draft themes, journey maps, or insights from the coded corpus', 59),
    )
    .option('--kind <kind>', 'themes | journey-map | insights', 'themes')
    // --seed is in the contract today even though the action is still stubbed
    // (#167): every seed-scoped command must accept it so a multi-seed workspace
    // is targetable from the moment `synthesize` ships.
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action(stubAction({ command: 'synthesize', issue: 59 }))
}
