import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { writeTranscriptMd } from '../render/transcript_md.js'
import { TranscriberClient, TranscriberServiceError } from '../transcriber_client.js'

interface TranscribeFlags {
  seed?: string
  baseUrl?: string
  language?: string
}

function resolveSource(seedPath: string, sessionId: string): string {
  const dir = join(seedPath, 'sessions', sessionId)
  if (!existsSync(dir)) throw new CompostError('FILE_NOT_FOUND', `No session ${sessionId}`)
  const src = readdirSync(dir).find((f) => f.startsWith('source.'))
  if (src === undefined) throw new CompostError('FILE_NOT_FOUND', `No source media in ${dir}`)
  return join(dir, src)
}

export function registerTranscribe(program: Command): void {
  program
    .command('transcribe')
    .description('Invoke the transcriber service directly on a session (agent-friendly)')
    .argument('<session-id>', 'Session id (e.g. S001)')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--base-url <url>', 'Transcriber base URL', 'http://localhost:7862')
    .option(
      '--language <tag>',
      'BCP-47 language hint (e.g. en, es-CO). Whisper auto-detects when omitted.',
    )
    .action(async (sessionId: string, flags: TranscribeFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const source = resolveSource(seedPath, sessionId)
        const client = new TranscriberClient(
          flags.baseUrl !== undefined ? { baseUrl: flags.baseUrl } : {},
        )
        const resp = await client.transcribe(source, sessionId, seedPath, flags.language)
        if (existsSync(resp.transcript_path)) writeTranscriptMd(resp.transcript_path)
        emit(
          {
            status: resp.status,
            command: 'transcribe',
            session_id: resp.session_id,
            transcript_path: resp.transcript_path,
          },
          out,
        )
      } catch (err) {
        if (err instanceof TranscriberServiceError) {
          // Exit 2 on service down / model missing (distinct from generic errors).
          if (out.human) process.stderr.write(`transcriber ${err.kind}: ${err.message}\n`)
          else
            process.stderr.write(
              `${JSON.stringify({ error: { code: 'PROVIDER_ERROR', kind: err.kind, message: err.message } })}\n`,
            )
          process.exit(2)
        }
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
