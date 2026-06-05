import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { transcribeNative } from '../lib/transcribeNative.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { writeTranscriptMd } from '../render/transcript_md.js'
import { TranscriberClient, TranscriberServiceError } from '../transcriber_client.js'

interface TranscribeFlags {
  seed?: string
  baseUrl?: string
  language?: string
  runtime?: string
  engine?: string
  model?: string
  python?: string
  transcriberDir?: string
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
    .option('--runtime <mode>', 'native (Apple-Silicon, no Docker) | docker', 'docker')
    .option('--engine <name>', 'ASR engine for the native runtime: parakeet | whisper', 'parakeet')
    .option('--model <id>', 'ASR model id (engine default when omitted)')
    .option('--python <path>', 'Native-runtime venv python (or env COMPOST_TRANSCRIBER_PYTHON)')
    .option(
      '--transcriber-dir <path>',
      'transcriber/ package dir for the native runtime (or env COMPOST_TRANSCRIBER_DIR)',
    )
    .action(async (sessionId: string, flags: TranscribeFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const source = resolveSource(seedPath, sessionId)

        // Native runtime (#176): run the pipeline on the host so Apple-Silicon
        // ASR (parakeet-mlx / Metal) + pyannote use the GPU/CPU directly.
        if ((flags.runtime ?? 'docker') === 'native') {
          const python = flags.python ?? process.env.COMPOST_TRANSCRIBER_PYTHON
          const transcriberDir = flags.transcriberDir ?? process.env.COMPOST_TRANSCRIBER_DIR
          if (python === undefined || transcriberDir === undefined) {
            throw new CompostError(
              'INVALID_INPUT',
              'native runtime needs --python and --transcriber-dir (or COMPOST_TRANSCRIBER_PYTHON / ' +
                'COMPOST_TRANSCRIBER_DIR). Run `compost setup` to provision the native venv.',
            )
          }
          const resp = transcribeNative(seedPath, sessionId, source, {
            python,
            transcriberDir,
            engine: flags.engine ?? 'parakeet',
            ...(flags.model !== undefined ? { model: flags.model } : {}),
            ...(flags.language !== undefined ? { language: flags.language } : {}),
          })
          if (existsSync(resp.transcript_path)) writeTranscriptMd(resp.transcript_path)
          emit(
            {
              status: resp.status,
              command: 'transcribe',
              session_id: resp.session_id,
              transcript_path: resp.transcript_path,
              runtime: 'native',
              engine: resp.engine ?? null,
              model: resp.model ?? null,
            },
            out,
          )
          return
        }

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
