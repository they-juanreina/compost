import { writeFileSync } from 'node:fs'

import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { type ExportFormat, exportTranscript, loadTranscript } from '../lib/export.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface ExportFlags {
  format: string
  out?: string
  createdDate?: string
}

export function registerExport(program: Command): void {
  program
    .command('export')
    .description('Export a transcript.json to CSV (legacy fact_utterances) or Markdown')
    .argument('<transcript-path>', 'Path to a transcript.json')
    .requiredOption('--format <fmt>', 'csv | md | eaf')
    .option('--out <path>', 'Write to a file instead of stdout')
    .option('--created-date <date>', 'Value for the legacy CSV created_date column')
    .action((transcriptPath: string, flags: ExportFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const format = flags.format as ExportFormat
        if (format !== 'csv' && format !== 'md' && format !== 'eaf') {
          throw new CompostError(
            'INVALID_INPUT',
            `--format must be csv, md, or eaf (got "${flags.format}")`,
          )
        }
        const transcript = loadTranscript(transcriptPath)
        const result = exportTranscript(
          transcript,
          flags.createdDate !== undefined ? { format, createdDate: flags.createdDate } : { format },
        )
        if (flags.out !== undefined) {
          writeFileSync(flags.out, result.content, 'utf8')
          emit(
            {
              status: 'ok',
              command: 'export',
              format,
              session_id: result.session_id,
              out: flags.out,
            },
            out,
          )
          return
        }
        if (out.human) {
          process.stdout.write(result.content)
        } else {
          emit(
            {
              status: 'ok',
              command: 'export',
              format,
              session_id: result.session_id,
              content: result.content,
            },
            out,
          )
        }
      } catch (err) {
        if (isCompostError(err)) {
          emitError(err, out)
        }
        throw err
      }
    })
}
