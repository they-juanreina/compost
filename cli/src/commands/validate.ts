import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerValidate(program: Command): void {
  const validate = program
    .command('validate')
    .description('Validate JSON artifacts against compost schemas')

  validate
    .command('transcript')
    .description('Validate a transcript.json against transcript.schema.json (#5)')
    .argument('<path>')
    .action(stubAction({ command: 'validate transcript' }))

  validate
    .command('cues')
    .description("Validate cues.taxonomy.json or a transcript's cue kinds (#6)")
    .argument('<path>')
    .action(stubAction({ command: 'validate cues' }))

  validate
    .command('frames')
    .description("Validate frames.taxonomy.json or a transcript's frame triggers (#7)")
    .argument('<path>')
    .action(stubAction({ command: 'validate frames' }))

  validate
    .command('events')
    .description('Validate provenance events against events.schema.json (#8)')
    .argument('<path>')
    .action(stubAction({ command: 'validate events' }))
}
