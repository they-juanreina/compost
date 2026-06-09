import { CompostError } from '../errors.js'
import type { Transcript, TranscriptSpeaker, TranscriptUtterance } from './transcript.js'

/**
 * Import an existing speaker + timestamp text transcript (#172) into compost's
 * transcript schema. Recognizes the common shapes:
 *   [00:01:23] Name: text        [01:23] Name: text
 *   00:01:23 Name: text
 *   Name (01:23): text
 * A line with no leading speaker/timestamp continues the previous utterance.
 */

export interface ImportOptions {
  sessionId: string
  source?: string
  language?: string
}

interface ParsedLine {
  ms: number
  speaker: string
  text: string
}

// [ts] Name: text   |   ts Name: text   |   Name (ts): text
const BRACKET_RE = /^\[(\d{1,2}:)?(\d{1,2}):(\d{2})(?:\.\d+)?\]\s*([^:]{1,80}?):\s*(.*)$/
const BARE_RE = /^(\d{1,2}:)?(\d{1,2}):(\d{2})\s+([^:]{1,80}?):\s*(.*)$/
const PAREN_RE = /^([^:(]{1,80}?)\s*\((\d{1,2}:)?(\d{1,2}):(\d{2})\):\s*(.*)$/

function toMs(h: string | undefined, m: string, s: string): number {
  const hours = h ? Number.parseInt(h, 10) : 0
  return (hours * 3600 + Number.parseInt(m, 10) * 60 + Number.parseInt(s, 10)) * 1000
}

function parseLine(line: string): ParsedLine | null {
  let m = BRACKET_RE.exec(line)
  if (m)
    return {
      ms: toMs(m[1], m[2] as string, m[3] as string),
      speaker: (m[4] as string).trim(),
      text: (m[5] as string).trim(),
    }
  m = BARE_RE.exec(line)
  if (m)
    return {
      ms: toMs(m[1], m[2] as string, m[3] as string),
      speaker: (m[4] as string).trim(),
      text: (m[5] as string).trim(),
    }
  m = PAREN_RE.exec(line)
  if (m)
    return {
      ms: toMs(m[2], m[3] as string, m[4] as string),
      speaker: (m[1] as string).trim(),
      text: (m[5] as string).trim(),
    }
  return null
}

const TAIL_MS = 2000

export function parseTextTranscript(raw: string, opts: ImportOptions): Transcript {
  const lines = raw.split(/\r?\n/)
  const parsed: ParsedLine[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    const hit = parseLine(line)
    if (hit !== null) {
      parsed.push(hit)
    } else if (parsed.length > 0) {
      // Continuation of the previous utterance.
      const prev = parsed[parsed.length - 1] as ParsedLine
      prev.text = `${prev.text} ${line.trim()}`.trim()
    }
    // A non-matching line before any speaker line is ignored (header/preamble).
  }
  if (parsed.length === 0) {
    throw new CompostError(
      'INVALID_INPUT',
      'No "Name: text" lines with timestamps recognized. Expected e.g. "[00:01:23] Juan: ..." or "Juan (01:23): ...".',
    )
  }

  // Assign stable speaker ids in first-seen order; first speaker = moderator.
  const speakerId = new Map<string, string>()
  const speakers: TranscriptSpeaker[] = []
  for (const p of parsed) {
    if (!speakerId.has(p.speaker)) {
      const id = `S${speakerId.size + 1}`
      speakerId.set(p.speaker, id)
      speakers.push({
        id,
        name: p.speaker,
        type: speakers.length === 0 ? 'moderator' : 'participant',
      })
    }
  }

  const utterances: TranscriptUtterance[] = parsed.map((p, i) => {
    const next = parsed[i + 1]
    const end_ms = next ? Math.max(next.ms, p.ms + 1) : p.ms + TAIL_MS
    return {
      id: `U-${String(i + 1).padStart(4, '0')}`,
      speaker_id: speakerId.get(p.speaker) as string,
      turn: i + 1,
      start_ms: p.ms,
      end_ms,
      text: p.text,
    } as TranscriptUtterance
  })

  return {
    schema_version: '1.0',
    kind: 'session',
    session_id: opts.sessionId,
    source: opts.source ?? `imported:${opts.sessionId}`,
    language: opts.language ?? 'und',
    duration_ms: utterances[utterances.length - 1]?.end_ms ?? 0,
    modality: ['audio'],
    speakers,
    utterances,
    provenance: { transcriber: 'compost-import@0.1.0' },
  } as unknown as Transcript
}
