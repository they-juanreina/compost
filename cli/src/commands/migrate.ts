import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerMigrate(program: Command): void {
  program
    .command('migrate')
    .description('Rename legacy 01_*/02_*/03_*/04_* seeds in place')
    .option('--dry-run', 'Preview the rename without touching the filesystem')
    .action(stubAction({ command: 'migrate', issue: 23 }))
}
