import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { snap } from '../lib/snap.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface SnapFlags {
  at: string
  seed?: string
}

export function registerSnap(program: Command): void {
  program
    .command('snap')
    .description('Capture a frame from a session video at a specific timestamp')
    .argument('<session-id>')
    .requiredOption('--at <timestamp>', 'Timestamp (ms, mm:ss, or hh:mm:ss) to capture')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((sessionId: string, flags: SnapFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const result = snap(seedPath, sessionId, flags.at)
        emit({ status: 'ok', command: 'snap', ...result }, out)
      } catch (err) {
        if (isCompostError(err)) {
          emitError(err, out)
        }
        throw err
      }
    })
}
