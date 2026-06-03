import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Scaffold a new Seeds/<name>/ tree plus .compost/ and config.toml')
    .argument('<seed-name>', 'Seed identifier (kebab-case)')
    .action(stubAction({ command: 'init', issue: 16 }))
}
