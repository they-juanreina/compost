import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { gatherStatus } from '../lib/status.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface StatusFlags {
  seed?: string
}

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description(
      'Print kind-grouped counts (sessions, transcripts, highlights, codes, themes, frames) for the current seed',
    )
    .option(
      '--seed <name>',
      'Scope the snapshot to a single seed (default: all seeds under ./Seeds)',
    )
    .action((flags: StatusFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const opts: { seed?: string } = {}
        if (flags.seed !== undefined) opts.seed = flags.seed
        const snapshot = gatherStatus(opts)
        emit(snapshot, out)
      } catch (err) {
        if (isCompostError(err)) {
          emitError(err, out)
        }
        throw err
      }
    })
}
