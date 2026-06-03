import type { Command } from 'commander'
import { saturationPulse } from 'compost-retrieval'

import { isCompostError } from '../errors.js'
import { gatherSessionsWithThemes } from '../lib/saturate.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface SaturateFlags {
  seed?: string
  dryStreak?: string
}

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
    .action((flags: SaturateFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const opts: { seed?: string } = {}
        if (flags.seed !== undefined) opts.seed = flags.seed
        const sessions = gatherSessionsWithThemes(opts)
        const pulse = saturationPulse(sessions, {
          dryStreakToConclude: Number(flags.dryStreak ?? 2),
        })
        emit(
          {
            status: 'ok',
            command: 'saturate',
            sessions: sessions.length,
            ...pulse,
          },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
