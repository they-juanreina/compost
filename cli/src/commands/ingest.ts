import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { ingestPath } from '../lib/ingest.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface IngestFlags {
  seed?: string
}

export function registerIngest(program: Command): void {
  program
    .command('ingest')
    .description(
      'Route audio/video to the transcriber and legacy artifacts to the legacy-ingest worker',
    )
    .argument('<path>', 'File or folder to ingest')
    .option('--seed <name>', 'Target seed (defaults to the only seed under ./Seeds)')
    .addHelpText(
      'after',
      '\nExamples:\n  $ compost ingest ./recording.m4a\n  $ compost ingest ./interviews/ --seed my-study   # a folder, recursively',
    )
    .action((target: string, flags: IngestFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const result = ingestPath(seedPath, target)
        emit({ status: 'ok', command: 'ingest', ...result }, out)
      } catch (err) {
        if (isCompostError(err)) {
          emitError(err, out)
        }
        throw err
      }
    })
}
