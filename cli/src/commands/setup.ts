import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { runSetup } from '../lib/setup.js'
import { emit, emitError, getOutputOpts } from '../output.js'

export function registerSetup(program: Command): void {
  program
    .command('setup')
    .description(
      'Health-check prerequisites (Ollama, models, Docker, transcriber, HF token + pyannote license, Seeds/) and report fixes',
    )
    .action(async (_flags: unknown, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const report = await runSetup({ cwd: process.cwd() })
        emit({ command: 'setup', ...report }, out)
        // Non-zero exit when any check failed, so CI / scripts can gate on it.
        if (!report.ready) process.exitCode = 1
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
