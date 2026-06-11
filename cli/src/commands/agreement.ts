import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { computeAgreement, readCodings } from '../lib/agreement.js'
import { eventsDbPath } from '../lib/events.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface AgreementFlags {
  seed?: string
  minUnits?: string
}

export function registerAgreement(program: Command): void {
  program
    .command('agreement')
    .description(
      "Human↔machine intercoder agreement: Cohen's κ + Krippendorff's α over highlights " +
        'coded by BOTH a blind researcher (`compost recode`) and the machine. Reports ' +
        '`insufficient` below the minimum sample (κ on a few items is noise).',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--min-units <n>', 'Minimum doubly-coded units for a meaningful κ', '10')
    .action((flags: AgreementFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const minUnits = Number.parseInt(flags.minUnits ?? '10', 10)
        if (!Number.isInteger(minUnits) || minUnits < 1) {
          throw new CompostError('INVALID_INPUT', `--min-units must be a positive integer`)
        }
        const eventsDb = eventsDbPath(seedPath)
        const { codings, excludedUnnamedMachineCodes } = readCodings(eventsDb)
        const report = computeAgreement(codings, { minUnits, excludedUnnamedMachineCodes })
        // report.status is 'ok' | 'insufficient' — the command succeeded either way.
        emit({ command: 'agreement', ...report }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
