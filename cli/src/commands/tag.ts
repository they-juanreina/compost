import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerTag(program: Command): void {
  program
    .command('tag')
    .description('Suggest or apply glossary terms / annotations across utterances')
    .option('--apply', 'Apply suggestions instead of only listing them')
    .action(stubAction({ command: 'tag', issue: 49 }))
}
