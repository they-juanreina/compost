import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { initSeed } from '../lib/seed.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface InitFlags {
  force?: boolean
  fromLegacy?: string
  fromSample?: boolean
  question?: string
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Scaffold a new Seeds/<name>/ tree plus .compost/ and config.toml')
    .argument('<seed-name>', 'Seed identifier (alphanumeric, plus - or _)')
    .option('--force', 'Overwrite an existing seed directory')
    .option(
      '--from-legacy <path>',
      'Migrate a legacy folder into the new seed (delegates to compost migrate)',
    )
    .option('--from-sample', 'Unpack the bundled sample seed (a redacted single-session corpus)')
    .option('--question <text>', 'The research question, written into seed.md')
    .addHelpText(
      'after',
      '\nExamples:\n  $ compost init my-study\n  $ compost init demo --from-sample\n  $ compost init edges --question "How does a researcher\'s standpoint shape a corpus reading?"',
    )
    .action((seedName: string, flags: InitFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const result = initSeed(seedName, {
          force: flags.force === true,
          fromSample: flags.fromSample === true,
          ...(flags.question !== undefined ? { question: flags.question } : {}),
        })
        if (flags.fromLegacy !== undefined) {
          emit(
            {
              status: 'partial',
              command: 'init',
              seed: result.seed_name,
              path: result.path,
              created_at: result.created_at,
              files: result.files,
              directories: result.directories,
              from_legacy: flags.fromLegacy,
              note: '--from-legacy migration is not yet wired (defers to #23 compost migrate)',
            },
            out,
          )
          return
        }
        emit(
          {
            status: 'ok',
            command: 'init',
            seed: result.seed_name,
            path: result.path,
            created_at: result.created_at,
            files: result.files,
            directories: result.directories,
            warnings: result.warnings,
          },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) {
          emitError(err, out)
        }
        throw err
      }
    })
}
