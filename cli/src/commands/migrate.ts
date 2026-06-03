import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { migrate } from '../lib/migrate.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface MigrateFlags {
  apply?: boolean
}

export function registerMigrate(program: Command): void {
  program
    .command('migrate')
    .description('Rename a legacy 01_*/02_*/03_*/04_* seed in place and scaffold .compost/')
    .argument('<path>', 'Path to the legacy seed directory')
    .option('--apply', 'Perform the migration (default is a read-only dry-run)')
    .action((seedPath: string, flags: MigrateFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const result = migrate(seedPath, { apply: flags.apply === true })
        emit(
          {
            status: result.applied ? 'ok' : 'dry_run',
            command: 'migrate',
            ...result,
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
