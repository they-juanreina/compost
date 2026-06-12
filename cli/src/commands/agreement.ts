import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { computeAgreementForFrame, readCodings } from '../lib/agreement.js'
import { resolveCodebookId } from '../lib/artifacts.js'
import { eventsDbPath } from '../lib/events.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface AgreementFlags {
  seed?: string
  minUnits?: string
  codebook?: string
}

export function registerAgreement(program: Command): void {
  program
    .command('agreement')
    .description(
      "Human↔machine intercoder agreement: Cohen's κ + Krippendorff's α over highlights " +
        'coded by BOTH a blind researcher (`compost recode`) and the machine, WITHIN one ' +
        'codebook (κ is undefined across frames). Reports `insufficient` below the minimum ' +
        'sample (κ on a few items is noise).',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--min-units <n>', 'Minimum doubly-coded units for a meaningful κ', '10')
    .option('--codebook <ref>', 'Codebook (frame) to measure within (default: primary)')
    .action((flags: AgreementFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const minUnits = Number.parseInt(flags.minUnits ?? '10', 10)
        if (!Number.isInteger(minUnits) || minUnits < 1) {
          throw new CompostError('INVALID_INPUT', `--min-units must be a positive integer`)
        }
        const codebookId = resolveCodebookId(seedPath, flags.codebook)
        const eventsDb = eventsDbPath(seedPath)
        const { codings, excludedUnnamedMachineCodes } = readCodings(eventsDb)
        // Scope to one frame: κ across codebooks is undefined by construction
        // (different code namespaces). Default `primary` preserves the
        // single-codebook behavior — every legacy coding reads as CB-primary.
        const report = computeAgreementForFrame(codings, excludedUnnamedMachineCodes, codebookId, {
          minUnits,
        })
        // report.status is 'ok' | 'insufficient' — the command succeeded either way.
        emit({ command: 'agreement', codebook: codebookId, ...report }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
