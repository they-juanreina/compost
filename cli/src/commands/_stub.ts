import type { Command } from 'commander'

import { emit, getOutputOpts } from '../output.js'

export interface StubInfo {
  command: string
  issue?: number
}

/** Prefix a command's description so `--help` clearly flags it as not built yet
 * (instead of reading like a working command). */
export function stubDescription(text: string, issue?: number): string {
  return `[not implemented yet${issue !== undefined ? ` · #${issue}` : ''}] ${text}`
}

export function stubAction(info: StubInfo): (...rest: unknown[]) => never {
  return (...rest: unknown[]) => {
    const cmd = rest[rest.length - 1] as Command
    const out = getOutputOpts(cmd)
    const positional = rest.slice(0, Math.max(0, rest.length - 2))
    if (out.human) {
      const ref = info.issue !== undefined ? ` (tracked in #${info.issue})` : ''
      process.stderr.write(`\`compost ${info.command}\` is not implemented yet${ref}.\n`)
    } else {
      emit(
        {
          status: 'not_implemented',
          command: info.command,
          ...(info.issue !== undefined ? { issue: info.issue } : {}),
          ...(positional.length > 0 ? { args: positional } : {}),
        },
        out,
      )
    }
    process.exit(1)
  }
}
