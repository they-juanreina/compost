import { saturationPulse } from '@they-juanreina/compost-retrieval'
import type { Command } from 'commander'
import { isCompostError } from '../errors.js'
import { resolveCodebookId } from '../lib/artifacts.js'
import { gatherSessionsWithThemes } from '../lib/saturate.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface SaturateFlags {
  seed?: string
  dryStreak?: string
  codebook?: string
}

/** Below this, a saturation curve can't be read — report `insufficient`. */
const MIN_SESSIONS = 2

export function registerSaturate(program: Command): void {
  program
    .command('saturate')
    .description(
      'Assess thematic saturation: per-session theme novelty + a continue/pause/conclude recommendation',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option(
      '--dry-streak <n>',
      'Consecutive dry sessions that trigger a conclude recommendation',
      '2',
    )
    .option(
      '--codebook <ref>',
      'Codebook (frame) to measure saturation within (default: primary); a deductive and an inductive lens saturate differently',
    )
    .action((flags: SaturateFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const codebookId = resolveCodebookId(seedPath, flags.codebook)
        const opts: { seed?: string; codebookId: string } = { codebookId }
        if (flags.seed !== undefined) opts.seed = flags.seed
        const sessions = gatherSessionsWithThemes(opts)
        const pulse = saturationPulse(sessions, {
          dryStreakToConclude: Number(flags.dryStreak ?? 2),
        })
        // A novelty curve needs at least two sessions to read; below that,
        // report `insufficient` (mirroring `agreement`'s minimum-sample gate)
        // rather than a bare `pause` that implies a measurement was made.
        const insufficient = sessions.length < MIN_SESSIONS
        emit(
          {
            status: 'ok',
            command: 'saturate',
            codebook: codebookId,
            sessions: sessions.length,
            ...pulse,
            ...(insufficient
              ? {
                  recommendation: 'insufficient',
                  rationale: `Saturation needs at least ${MIN_SESSIONS} sessions to read a novelty curve; this ${codebookId} frame has ${sessions.length}. Code more sessions before drawing a conclusion.`,
                }
              : {}),
          },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
