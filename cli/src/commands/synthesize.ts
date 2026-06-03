import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerSynthesize(program: Command): void {
  program
    .command('synthesize')
    .description('Draft themes, journey maps, or insights from the coded corpus')
    .option('--kind <kind>', 'themes | journey-map | insights', 'themes')
    .action(stubAction({ command: 'synthesize', issue: 59 }))
}
