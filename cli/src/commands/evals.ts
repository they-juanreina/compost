import type { Command } from 'commander'

import { runGolden } from 'compost-evals'

import { isCompostError } from '../errors.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { stubAction } from './_stub.js'

interface RunFlags {
  skill: string
}

export function registerEvals(program: Command): void {
  const evals = program.command('evals').description('Skill / suggestion / harness eval runners')

  evals
    .command('run')
    .description('Run a golden-set eval for a skill (coverage / faithfulness / schema)')
    .requiredOption(
      '--skill <name>',
      'querying-research-knowledge | thematic-coding | saturation-analysis',
    )
    .action(async (flags: RunFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        // Identity runner: scores the golden expected outputs against themselves,
        // establishing the harness + fixtures. A real skill runner is injected
        // once the refactored skills (#51-53) are wired.
        const result = await runGolden(flags.skill, (input: unknown) => input)
        emit({ command: 'evals run', ...result }, out)
        if (!result.passed) process.exitCode = 1
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  evals
    .command('harness')
    .description('Run the end-to-end harness eval suite')
    .action(stubAction({ command: 'evals harness', issue: 67 }))
}
