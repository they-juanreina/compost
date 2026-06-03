import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerExport(program: Command): void {
  program
    .command('export')
    .description('Export transcripts or flat utterances to CSV/Markdown')
    .requiredOption('--format <fmt>', 'csv | markdown')
    .option('--scope <scope>', 'transcripts | utterances', 'transcripts')
    .option('--out <path>', 'Output file or folder')
    .action(stubAction({ command: 'export', issue: 24 }))
}
