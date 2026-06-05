import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { blame, renderHuman } from '../lib/blame.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface BlameFlags {
  seed?: string
}

export function registerBlame(program: Command): void {
  program
    .command('blame')
    .description('Print the lineage chain (three-actor events) for an artifact')
    .argument(
      '<artifact-ref>',
      'Id from `compost create` (C-slug / H-NNN / T-slug), SHA256 prefix (min 8 chars), or `latest:<kind>=<seed>`',
    )
    .option(
      '--seed <name>',
      'Scope the lookup to a single seed (default: the only seed under ./Seeds)',
    )
    .action((artifactRef: string, flags: BlameFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const opts: { seed?: string } = {}
        if (flags.seed !== undefined) opts.seed = flags.seed
        const result = blame(artifactRef, opts)
        if (out.human) {
          process.stdout.write(`${renderHuman(result)}\n`)
          return
        }
        emit(result, out)
      } catch (err) {
        if (isCompostError(err)) {
          emitError(err, out)
        }
        throw err
      }
    })
}
