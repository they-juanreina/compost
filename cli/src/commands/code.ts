import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerCode(program: Command): void {
  program
    .command('code')
    .description('Suggest or apply codes on highlights via the cross-session-similarity scanner')
    .option('--apply', 'Apply suggestions instead of only listing them')
    .action(stubAction({ command: 'code', issue: 49 }))
}
