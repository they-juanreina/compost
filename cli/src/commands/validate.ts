import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import {
  validateCues,
  validateEventsExport,
  validateFrames,
  validateSeed,
  validateTranscript,
} from '../lib/validate.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface SeedFlags {
  seed?: string
}

export function registerValidate(program: Command): void {
  const validate = program
    .command('validate')
    .description('Validate JSON artifacts against compost schemas')

  validate
    .command('seed')
    .description(
      'Validate a whole seed: every transcript.json + normalized legacy + the event log (#174)',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((flags: SeedFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const result = validateSeed(seedPath)
        emit(
          {
            status: result.ok ? 'ok' : 'invalid',
            command: 'validate seed',
            seed: result.seed,
            transcripts_checked: result.transcripts.length,
            transcripts_invalid: result.transcripts.filter((t) => !t.ok).length,
            events: result.events,
            invalid: result.transcripts.filter((t) => !t.ok),
          },
          out,
        )
        if (!result.ok) process.exit(1)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  validate
    .command('transcript')
    .description('Validate a transcript.json against transcript.schema.json (#5)')
    .argument('<path>')
    .action((path: string, _opts, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const result = validateTranscript(path)
        emit(
          { status: result.ok ? 'ok' : 'invalid', command: 'validate transcript', ...result },
          out,
        )
        if (!result.ok) process.exit(1)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  validate
    .command('cues')
    .description("Validate cues.taxonomy.json or a transcript's cue kinds (#6)")
    .argument('<path>')
    .action((path: string, _opts, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const result = validateCues(path)
        emit({ status: result.ok ? 'ok' : 'invalid', command: 'validate cues', ...result }, out)
        if (!result.ok) process.exit(1)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  validate
    .command('frames')
    .description("Validate frames.taxonomy.json or a transcript's frame triggers (#7)")
    .argument('<path>')
    .action((path: string, _opts, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const result = validateFrames(path)
        emit({ status: result.ok ? 'ok' : 'invalid', command: 'validate frames', ...result }, out)
        if (!result.ok) process.exit(1)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  validate
    .command('events')
    .description('Validate provenance events against events.schema.json (#8)')
    .argument('<path>')
    .action((path: string, _opts, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const result = validateEventsExport(path)
        emit({ status: result.ok ? 'ok' : 'invalid', command: 'validate events', ...result }, out)
        if (!result.ok) process.exit(1)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
