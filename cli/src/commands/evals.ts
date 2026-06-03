import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerEvals(program: Command): void {
  const evals = program.command('evals').description('Skill / suggestion / harness eval runners')

  evals
    .command('run')
    .description('Run a golden-set eval for a skill')
    .requiredOption('--skill <name>')
    .action(stubAction({ command: 'evals run', issue: 56 }))

  evals
    .command('harness')
    .description('Run the end-to-end harness eval suite')
    .action(stubAction({ command: 'evals harness', issue: 67 }))
}
