import { existsSync, readFileSync } from 'node:fs'
import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { defaultResearcherId } from '../lib/artifacts.js'
import { blindRecode } from '../lib/recode.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface RecodeFlags {
  seed?: string
  assignments: string
  coder?: string
}

/** Validate the assignments file is { "H-001": ["code-a", ...], ... }. */
function parseAssignments(path: string): Record<string, string[]> {
  if (!existsSync(path)) {
    throw new CompostError('FILE_NOT_FOUND', `No assignments file at ${path}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw new CompostError('INVALID_INPUT', `Could not parse assignments JSON at ${path}`, {
      cause,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CompostError(
      'SCHEMA_VIOLATION',
      'Assignments must be a JSON object mapping highlight id → array of code names.',
    )
  }
  const out: Record<string, string[]> = {}
  for (const [highlight, codes] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(codes) || codes.some((c) => typeof c !== 'string')) {
      throw new CompostError(
        'SCHEMA_VIOLATION',
        `Assignment for "${highlight}" must be an array of code-name strings.`,
      )
    }
    out[highlight] = codes as string[]
  }
  return out
}

export function registerRecode(program: Command): void {
  program
    .command('recode')
    .description(
      'Record a researcher\'s blind (independent) codings for intercoder agreement. ' +
        'Code highlights against the shared codebook WITHOUT seeing the machine codes, ' +
        'then `compost agreement` computes Cohen\'s κ over the doubly-coded set.',
    )
    .requiredOption(
      '--assignments <path>',
      'JSON file mapping highlight id → array of code names, e.g. {"H-001":["distrust"]}',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--coder <id>', 'Researcher id for these codings (default: $COMPOST_USER)')
    .action((flags: RecodeFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const assignments = parseAssignments(flags.assignments)
        const result = blindRecode(seedPath, {
          assignments,
          researcherId: flags.coder ?? defaultResearcherId(),
        })
        emit({ status: 'ok', command: 'recode', blind: true, ...result }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
