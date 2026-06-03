import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerChat(program: Command): void {
  program
    .command('chat')
    .description('RAG-grounded chat with the seed — answers carry citations')
    .option('--seed <name>', 'Override the seed root')
    .action(stubAction({ command: 'chat', issue: 48 }))
}
