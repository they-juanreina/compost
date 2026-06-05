import type { Command } from 'commander'

import { stubAction, stubDescription } from './_stub.js'

export function registerServe(program: Command): void {
  program
    .command('serve')
    .description(stubDescription('Start the local Next.js web UI on http://localhost:7860', 32))
    .option('--port <port>', 'TCP port', '7860')
    .action(stubAction({ command: 'serve', issue: 32 }))
}
