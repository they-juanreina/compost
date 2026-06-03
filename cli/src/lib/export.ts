import { existsSync, readFileSync } from 'node:fs'

import { CompostError } from '../errors.js'
import { transcriptToCsv } from '../exporters/csv.js'
import { transcriptToMarkdown } from '../exporters/md.js'
import type { Transcript } from './transcript.js'

export type ExportFormat = 'csv' | 'md'

export interface ExportOptions {
  format: ExportFormat
  createdDate?: string
}

export interface ExportResult {
  format: ExportFormat
  session_id: string
  content: string
}

export function loadTranscript(path: string): Transcript {
  if (!existsSync(path)) {
    throw new CompostError('FILE_NOT_FOUND', `No transcript at ${path}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw new CompostError('INVALID_INPUT', `Could not parse JSON at ${path}`, { cause })
  }
  const t = parsed as Partial<Transcript>
  if (typeof t.session_id !== 'string' || !Array.isArray(t.utterances)) {
    throw new CompostError(
      'SCHEMA_VIOLATION',
      `${path} is not a transcript (missing session_id or utterances)`,
    )
  }
  return parsed as Transcript
}

export function exportTranscript(transcript: Transcript, opts: ExportOptions): ExportResult {
  const content =
    opts.format === 'csv'
      ? transcriptToCsv(
          transcript,
          opts.createdDate !== undefined ? { createdDate: opts.createdDate } : {},
        )
      : transcriptToMarkdown(transcript)
  return { format: opts.format, session_id: transcript.session_id, content }
}
