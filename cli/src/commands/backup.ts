import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { type BackupResult, backupSeed } from '../lib/backup.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface BackupFlags {
  seed?: string
  out?: string
  verify?: boolean
}

export function registerBackup(program: Command): void {
  program
    .command('backup')
    .description(
      "Back up a seed's canonical provenance. .compost/events.sqlite is append-only and NOT rebuildable, yet it's gitignored — this copies the ledger and writes a portable PROV-O bundle into exports/ so it travels with the seed.",
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--out <dir>', 'Output directory (default: <seed>/exports)')
    .option('--verify', 'Only check the ledger is present and readable; write nothing')
    .action((flags: BackupFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const result = backupSeed(seedPath, {
          ...(flags.out !== undefined ? { outDir: flags.out } : {}),
          ...(flags.verify === true ? { verify: true } : {}),
        })
        emit({ status: 'ok', command: 'backup', ...result }, out, (d: BackupResult) =>
          d.mode === 'verify'
            ? `ledger OK: ${d.entities} entities, ${d.activities} activities, ${d.agents} agents at ${d.events_db}`
            : `Backed up provenance: ledger → ${d.ledger_copy}, PROV-O → ${d.provenance} (${d.entities} entities, ${d.activities} activities). Keep this with the seed if you move it.`,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
