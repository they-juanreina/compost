import type { Command } from 'commander'

import { stubAction, stubDescription } from './_stub.js'

export function registerQuery(program: Command): void {
  program
    .command('query')
    .description(stubDescription('Run a one-shot RAG query against the seed (no chat loop)', 51))
    .argument('<question>')
    // --seed is in the contract today even though the action is still stubbed
    // (#167): every seed-scoped command must accept it so a multi-seed workspace
    // is targetable from the moment `query` ships.
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action(stubAction({ command: 'query', issue: 51 }))
}
