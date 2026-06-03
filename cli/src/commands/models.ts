import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerModels(program: Command): void {
  const models = program.command('models').description('LLM provider helpers')

  models
    .command('doctor')
    .description('Probe configured providers and report health + per-task coverage')
    .action(stubAction({ command: 'models doctor', issue: 26 }))
}
