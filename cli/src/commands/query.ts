import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerQuery(program: Command): void {
  program
    .command('query')
    .description('Run a one-shot RAG query against the seed (no chat loop)')
    .argument('<question>')
    .action(stubAction({ command: 'query', issue: 51 }))
}
