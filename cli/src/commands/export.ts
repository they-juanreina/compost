import { writeFileSync } from 'node:fs'

import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { eventsToProvO } from '../exporters/prov.js'
import { eventsDbPath } from '../lib/events.js'
import { type ExportFormat, exportTranscript, loadTranscript } from '../lib/export.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface ExportFlags {
  format: string
  out?: string
  createdDate?: string
  seed?: string
}

export function registerExport(program: Command): void {
  program
    .command('export')
    .description(
      "Export a transcript.json (csv | md | eaf), or a seed's provenance event log to W3C PROV-O JSON-LD (prov).",
    )
    .argument('[transcript-path]', 'Path to a transcript.json (required for csv | md | eaf)')
    .requiredOption('--format <fmt>', 'csv | md | eaf | prov')
    .option('--out <path>', 'Write to a file instead of stdout')
    .option('--created-date <date>', 'Value for the legacy CSV created_date column')
    .option('--seed <name>', 'Seed (for --format prov; default: the only seed under ./Seeds)')
    .action((transcriptPath: string | undefined, flags: ExportFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        // PROV-O exports the event log, not a transcript.
        if (flags.format === 'prov') {
          const seedPath = resolveSeedPath(process.cwd(), flags.seed)
          const prov = eventsToProvO(eventsDbPath(seedPath))
          const content = JSON.stringify(prov.document, null, 2)
          if (flags.out !== undefined) {
            writeFileSync(flags.out, content, 'utf8')
            emit(
              {
                status: 'ok',
                command: 'export',
                format: 'prov',
                entities: prov.entities,
                activities: prov.activities,
                agents: prov.agents,
                inputs: prov.inputs,
                out: flags.out,
              },
              out,
            )
            return
          }
          if (out.human) {
            process.stdout.write(content)
          } else {
            emit(
              {
                status: 'ok',
                command: 'export',
                format: 'prov',
                entities: prov.entities,
                activities: prov.activities,
                agents: prov.agents,
                inputs: prov.inputs,
                content,
              },
              out,
            )
          }
          return
        }

        const format = flags.format as ExportFormat
        if (format !== 'csv' && format !== 'md' && format !== 'eaf') {
          throw new CompostError(
            'INVALID_INPUT',
            `--format must be csv, md, eaf, or prov (got "${flags.format}")`,
          )
        }
        if (transcriptPath === undefined) {
          throw new CompostError(
            'INVALID_INPUT',
            `<transcript-path> is required for --format ${format}`,
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
