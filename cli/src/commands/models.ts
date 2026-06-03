import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { loadConfig } from '../lib/config.js'
import { runDoctor } from '../lib/doctor.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { LLMAdapter } from '../llm/adapter.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface DoctorFlags {
  seed?: string
}

export function registerModels(program: Command): void {
  const models = program.command('models').description('LLM provider helpers')

  models
    .command('doctor')
    .description('Probe configured providers and report health + per-task coverage')
    .option(
      '--seed <name>',
      'Seed whose config.toml to read (default: the only seed under ./Seeds)',
    )
    .action(async (flags: DoctorFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const config = loadConfig(seedPath)
        const adapter = new LLMAdapter(config)
        const report = await runDoctor(adapter, config)
        emit({ command: 'models doctor', ...report }, out)
        if (!report.ok) process.exitCode = 1
      } catch (err) {
        if (isCompostError(err)) {
          emitError(err, out)
        }
        throw err
      }
    })
}
