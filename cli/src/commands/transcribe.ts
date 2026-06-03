import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerTranscribe(program: Command): void {
  program
    .command('transcribe')
    .description(
      'Invoke the transcriber service directly on a single audio/video file (agent-friendly)',
    )
    .argument('<path>', 'Audio or video file')
    .option('--session <id>', 'Override the generated session id')
    .action(stubAction({ command: 'transcribe', issue: 18 }))
}
