import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { initSeed } from '../lib/seed.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface InitFlags {
  force?: boolean
  fromLegacy?: string
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
    .action((seedName: string, flags: InitFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const result = initSeed(seedName, { force: flags.force === true })
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
