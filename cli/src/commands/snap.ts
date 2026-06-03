import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerSnap(program: Command): void {
  program
    .command('snap')
    .description('Capture a frame from a session video at a specific timestamp')
    .argument('<session-id>')
    .requiredOption(
      '--at <timestamp>',
      'Timestamp (ms or mm:ss) where the frame should be captured',
    )
    .action(stubAction({ command: 'snap', issue: 20 }))
}
