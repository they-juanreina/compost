import type { Command } from 'commander'

import { stubAction, stubDescription } from './_stub.js'

export function registerQuery(program: Command): void {
  program
    .command('query')
    .description(stubDescription('Run a one-shot RAG query against the seed (no chat loop)', 51))
    .argument('<question>')
    .action(stubAction({ command: 'query', issue: 51 }))
}
