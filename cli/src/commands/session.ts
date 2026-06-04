import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { getSession } from '../lib/session.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface SessionFlags {
  seed?: string
}

export function registerSession(program: Command): void {
  program
    .command('session')
    .description('Print a session transcript + frame index as JSON (agent-friendly read)')
    .argument('<session-id>', 'Session id (e.g. S001)')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((sessionId: string, flags: SessionFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const view = getSession(seedPath, sessionId)
        emit({ status: 'ok', command: 'session', ...view }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
