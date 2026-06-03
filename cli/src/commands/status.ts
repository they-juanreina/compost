import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description(
      'Print kind-grouped counts (sessions, transcripts, highlights, codes, themes, frames) for the current seed',
    )
    .action(stubAction({ command: 'status', issue: 21 }))
}
