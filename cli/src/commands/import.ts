import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { parseCaptionTranscript, parseTextTranscript } from '../lib/importTranscript.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { assertSessionContained } from '../lib/sessionId.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { writeTranscriptMd } from '../render/transcript_md.js'

interface ImportFlags {
  seed?: string
  session?: string
  language?: string
}

/** Slugify a filename stem into a filesystem-safe session id. */
function deriveSession(file: string): string {
  const stem = basename(file).replace(/\.[^.]+$/, '')
  const slug = stem.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'imported'
}

export function registerImport(program: Command): void {
  program
    .command('import')
    .description(
      'Import an existing transcript into a session transcript.json (#172) — no ' +
        're-transcription. Recognizes speaker+timestamp text (.txt: "[00:01] Name: text", ' +
        '"Name (01:23): text") and caption files (.vtt WebVTT / .srt SubRip from Teams/Zoom/Otter).',
    )
    .argument('<file>', 'Path to a transcript (.txt, .vtt, or .srt)')
    .option('--session <id>', 'Target session id (default: derived from the filename)')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--language <tag>', 'BCP-47 language tag for the transcript (default: und)')
    .action((file: string, flags: ImportFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        if (!existsSync(file)) throw new CompostError('FILE_NOT_FOUND', `No such file: ${file}`)
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const sessionId = flags.session ?? deriveSession(file)
        // A user-supplied --session must not contain path separators or `..`, and
        // must resolve under <seed>/sessions/ — it is joined straight into that
        // tree and written to below (#211 followup).
        assertSessionContained(seedPath, sessionId)
        const parseOpts = {
          sessionId,
          source: file,
          ...(flags.language !== undefined ? { language: flags.language } : {}),
        }
        const ext = extname(file).toLowerCase()
        const raw = readFileSync(file, 'utf8')
        const transcript =
          ext === '.vtt' || ext === '.srt'
            ? parseCaptionTranscript(raw, parseOpts)
            : parseTextTranscript(raw, parseOpts)

        const dir = join(seedPath, 'sessions', sessionId)
        mkdirSync(dir, { recursive: true })
        const transcriptPath = join(dir, 'transcript.json')
        if (existsSync(transcriptPath)) {
          throw new CompostError(
            'INVALID_INPUT',
            `Session ${sessionId} already has a transcript.json — pick another --session.`,
          )
        }
        writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8')
        writeTranscriptMd(transcriptPath)

        emit(
          {
            status: 'ok',
            command: 'import',
            session: sessionId,
            transcript_path: transcriptPath,
            speakers: transcript.speakers.length,
            utterances: transcript.utterances.length,
          },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
