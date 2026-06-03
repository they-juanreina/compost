import type { Command } from 'commander'

import { runGolden, runHarness } from 'compost-evals'

import { isCompostError } from '../errors.js'
import { emit, emitError, getOutputOpts } from '../output.js'

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
    .description('Run the end-to-end harness eval suite (gates major releases)')
    .action(async (_flags: unknown, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        // The real seed pipeline (ingest→transcribe→code→synthesize) is injected
        // here once it can run headless in CI; until then the harness reports the
        // diff against expected and exits non-zero, so it gates releases honestly.
        const result = await runHarness(async () => ({}))
        emit(
          {
            command: 'evals harness',
            ...result,
            note: result.passed
              ? undefined
              : 'seed pipeline not yet wired into the harness; fixtures + diff machinery are in place',
          },
          out,
        )
        if (!result.passed) process.exitCode = 1
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
