import type { Command } from 'commander'

import { stubAction, stubDescription } from './_stub.js'

export function registerSynthesize(program: Command): void {
  program
    .command('synthesize')
    .description(
      stubDescription('Draft themes, journey maps, or insights from the coded corpus', 59),
    )
    .option('--kind <kind>', 'themes | journey-map | insights', 'themes')
    .action(stubAction({ command: 'synthesize', issue: 59 }))
}
