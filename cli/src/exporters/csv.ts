import type { Transcript } from '../lib/transcript.js'
import { wordCount } from '../lib/transcript.js'

// Column order matches the legacy research-os fact_utterances.csv layout exactly.
export const CSV_COLUMNS = [
  'utterance_id',
  'interview_id',
  'speaker_id',
  'speaker_name',
  'speaker_type',
  'turn_number',
  'text',
  'word_count',
  'char_count',
  'created_date',
] as const

function csvCell(value: string | number): string {
  const s = String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export interface CsvOptions {
  /** Value for the legacy `created_date` column (not present in transcript.json). */
  createdDate?: string
}

export function transcriptToCsv(transcript: Transcript, opts: CsvOptions = {}): string {
  const speakerById = new Map(transcript.speakers.map((s) => [s.id, s]))
  const createdDate = opts.createdDate ?? ''

  const rows: string[] = [CSV_COLUMNS.join(',')]
  for (const u of transcript.utterances) {
    const speaker = speakerById.get(u.speaker_id)
    const cells = [
      u.id,
      transcript.session_id,
      u.speaker_id,
      speaker?.name ?? '',
      speaker?.type ?? '',
      u.turn,
      u.text,
      wordCount(u.text),
      u.text.length,
      createdDate,
    ]
    rows.push(cells.map(csvCell).join(','))
  }
  return `${rows.join('\n')}\n`
}
