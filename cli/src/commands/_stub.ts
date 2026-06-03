import type { Command } from 'commander'

import { emit, getOutputOpts } from '../output.js'

export interface StubInfo {
  command: string
  issue?: number
}

export function stubAction(info: StubInfo): (...rest: unknown[]) => never {
  return (...rest: unknown[]) => {
    const cmd = rest[rest.length - 1] as Command
    const out = getOutputOpts(cmd)
    const positional = rest.slice(0, Math.max(0, rest.length - 2))
    emit(
      {
        status: 'not_implemented',
        command: info.command,
        ...(info.issue !== undefined ? { issue: info.issue } : {}),
        ...(positional.length > 0 ? { args: positional } : {}),
      },
      out,
    )
    process.exit(1)
  }
}
