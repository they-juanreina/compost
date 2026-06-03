import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerServe(program: Command): void {
  program
    .command('serve')
    .description('Start the local Next.js web UI on http://localhost:7860')
    .option('--port <port>', 'TCP port', '7860')
    .action(stubAction({ command: 'serve', issue: 32 }))
}
