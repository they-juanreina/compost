import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerIngest(program: Command): void {
  program
    .command('ingest')
    .description(
      'Route audio/video to the transcriber and legacy artifacts to the legacy-ingest worker',
    )
    .argument('<path>', 'File or folder to ingest')
    .option('--seed <name>', 'Target seed (defaults to nearest seed root)')
    .option('--map <pair...>', 'CSV column mapping, e.g. text=Quote speaker=Participant')
    .action(stubAction({ command: 'ingest', issue: 17 }))
}
