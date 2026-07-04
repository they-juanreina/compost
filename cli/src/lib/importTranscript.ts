import { CompostError } from '../errors.js'
import type { Transcript, TranscriptSpeaker, TranscriptUtterance } from './transcript.js'

/**
 * Import an existing transcript into compost's transcript schema without a
 * re-transcription pass (#172). Two families are recognized:
 *
 *  - Speaker + timestamp text (`parseTextTranscript`):
 *      [00:01:23] Name: text     00:01:23 Name: text     Name (01:23): text
 *  - Caption / subtitle files (`parseCaptionTranscript`): WebVTT (`.vtt`) and
 *      SubRip (`.srt`) — the formats Teams / Zoom / Otter / YouTube export.
 *
 * All paths converge on `assembleTranscript`, so a caption import and a text
 * import produce byte-identical transcript shapes.
 */

export interface ImportOptions {
  sessionId: string
  source?: string
  language?: string
}

/** A resolved line of dialogue, ready to become an utterance. `speaker`
 * undefined ⇒ the source carried no speaker label for this line. */
interface AssembleRow {
  start_ms: number
  end_ms: number
  speaker?: string
  text: string
}

// Sentinel for lines with no detectable speaker — cannot collide with a real
// label. Assembled as a single `other`-type speaker (undiarized captions).
const UNKNOWN_SPEAKER = 'compost:unknown-speaker'
const TAIL_MS = 2000

// ── Speaker + timestamp text ────────────────────────────────────────────────

// [ts] Name: text   |   ts Name: text   |   Name (ts): text
const BRACKET_RE = /^\[(\d{1,2}:)?(\d{1,2}):(\d{2})(?:\.\d+)?\]\s*([^:]{1,80}?):\s*(.*)$/
const BARE_RE = /^(\d{1,2}:)?(\d{1,2}):(\d{2})\s+([^:]{1,80}?):\s*(.*)$/
const PAREN_RE = /^([^:(]{1,80}?)\s*\((\d{1,2}:)?(\d{1,2}):(\d{2})\):\s*(.*)$/

interface ParsedLine {
  ms: number
  speaker: string
  text: string
}

function hmsToMs(h: string | undefined, m: string, s: string): number {
  const hours = h ? Number.parseInt(h, 10) : 0
  return (hours * 3600 + Number.parseInt(m, 10) * 60 + Number.parseInt(s, 10)) * 1000
}

function parseLine(line: string): ParsedLine | null {
  let m = BRACKET_RE.exec(line)
  if (m)
    return {
      ms: hmsToMs(m[1], m[2] as string, m[3] as string),
      speaker: (m[4] as string).trim(),
      text: (m[5] as string).trim(),
    }
  m = BARE_RE.exec(line)
  if (m)
    return {
      ms: hmsToMs(m[1], m[2] as string, m[3] as string),
      speaker: (m[4] as string).trim(),
      text: (m[5] as string).trim(),
    }
  m = PAREN_RE.exec(line)
  if (m)
    return {
      ms: hmsToMs(m[2], m[3] as string, m[4] as string),
      speaker: (m[1] as string).trim(),
      text: (m[5] as string).trim(),
    }
  return null
}

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
      'No "Name: text" lines with timestamps recognized. Expected e.g. "[00:01:23] Juan: ..." or "Juan (01:23): ...". For a .vtt/.srt caption file, import it directly — the extension selects the caption parser.',
    )
  }

  // Text transcripts carry no end times: chain each utterance to the next start.
  const rows: AssembleRow[] = parsed.map((p, i) => {
    const next = parsed[i + 1]
    return {
      start_ms: p.ms,
      end_ms: next ? Math.max(next.ms, p.ms + 1) : p.ms + TAIL_MS,
      speaker: p.speaker,
      text: p.text,
    }
  })
  return assembleTranscript(rows, opts)
}

// ── Caption / subtitle files (WebVTT + SubRip) ──────────────────────────────

/** `HH:MM:SS.mmm`, `MM:SS.mmm`, or the SubRip comma variant → milliseconds. */
function clockToMs(clock: string): number | null {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(clock.trim())
  if (m === null) return null
  const hh = m[1] ? Number.parseInt(m[1], 10) : 0
  const mm = Number.parseInt(m[2] as string, 10)
  const ss = Number.parseInt(m[3] as string, 10)
  const frac = Number.parseInt((m[4] as string).padEnd(3, '0').slice(0, 3), 10)
  return (hh * 3600 + mm * 60 + ss) * 1000 + frac
}

/** Pull a speaker label off a cue's text, if the source encodes one:
 *   WebVTT voice span `<v Name>…`, or a leading `Name:` / `- Name:` prefix. */
function extractSpeaker(text: string): { speaker?: string; text: string } {
  const voice = /^<v(?:\.[^\s>]+)*\s+([^>]+)>/i.exec(text)
  if (voice) {
    return { speaker: (voice[1] as string).trim(), text: stripCaptionMarkup(text) }
  }
  const stripped = stripCaptionMarkup(text)
  // Conservative label match: a short, name-shaped prefix — avoids eating a
  // sentence that merely contains a colon.
  const prefix = /^-?\s*([A-Za-z][\w .'-]{0,39}):\s+(\S.*)$/.exec(stripped)
  if (prefix) {
    return { speaker: (prefix[1] as string).trim(), text: (prefix[2] as string).trim() }
  }
  return { text: stripped.replace(/^-\s+/, '').trim() }
}

/** Remove caption markup: HTML-ish tags (`<i>`, `<v …>`, `</v>`) and SubRip
 * position overrides (`{\an8}`). */
function stripCaptionMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\{[^}]*\}/g, '')
    .trim()
}

/**
 * Parse a WebVTT (`.vtt`) or SubRip (`.srt`) file. Both are blank-line-delimited
 * cue blocks; each cue has a `HH:MM:SS --> HH:MM:SS` timing line (SubRip's
 * leading index line and WebVTT's `WEBVTT` / `NOTE` / `STYLE` blocks have no
 * `-->` and are skipped). Speaker labels are lifted when present; a caption file
 * with none becomes a single-speaker session (honest: it wasn't diarized).
 */
export function parseCaptionTranscript(raw: string, opts: ImportOptions): Transcript {
  const blocks = raw.replace(/^\uFEFF/, '').split(/\r?\n\r?\n+/)
  const rows: AssembleRow[] = []
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== '')
    const tIdx = lines.findIndex((l) => l.includes('-->'))
    if (tIdx === -1) continue // header / NOTE / STYLE / index-only block

    const [startRaw, endRaw] = (lines[tIdx] as string).split('-->')
    if (endRaw === undefined) continue
    const start_ms = clockToMs(startRaw as string)
    // WebVTT allows cue settings after the end time ("… align:start"); take the
    // first token.
    const end_ms = clockToMs((endRaw.trim().split(/\s+/)[0] as string) ?? '')
    if (start_ms === null || end_ms === null) continue

    const payload = lines
      .slice(tIdx + 1)
      .join(' ')
      .trim()
    if (payload === '') continue
    const { speaker, text } = extractSpeaker(payload)
    if (text === '') continue
    rows.push({
      start_ms,
      end_ms: Math.max(end_ms, start_ms + 1),
      ...(speaker !== undefined && speaker !== '' ? { speaker } : {}),
      text,
    })
  }

  if (rows.length === 0) {
    throw new CompostError(
      'INVALID_INPUT',
      'No caption cues with timestamps recognized. Expected WebVTT ("00:00:01.000 --> 00:00:04.000") or SubRip ("00:00:01,000 --> 00:00:04,000") blocks.',
    )
  }
  return assembleTranscript(rows, opts)
}

// ── Shared assembly ─────────────────────────────────────────────────────────

/**
 * Build a schema-valid `Transcript` from resolved rows. Speaker ids are `S1..Sn`
 * in first-seen order; the first named speaker is the `moderator`, the rest
 * `participant`, mirroring the text-import convention. Rows with no label share
 * one `other`-type speaker (undiarized captions).
 */
function assembleTranscript(rows: AssembleRow[], opts: ImportOptions): Transcript {
  const speakerId = new Map<string, string>()
  const speakers: TranscriptSpeaker[] = []
  let namedCount = 0
  for (const r of rows) {
    const key = r.speaker !== undefined && r.speaker !== '' ? r.speaker : UNKNOWN_SPEAKER
    if (!speakerId.has(key)) {
      const id = `S${speakerId.size + 1}`
      speakerId.set(key, id)
      if (key === UNKNOWN_SPEAKER) {
        speakers.push({ id, type: 'other' })
      } else {
        speakers.push({
          id,
          name: key,
          type: namedCount === 0 ? 'moderator' : 'participant',
        })
        namedCount += 1
      }
    }
  }

  const utterances: TranscriptUtterance[] = rows.map((r, i) => {
    const key = r.speaker !== undefined && r.speaker !== '' ? r.speaker : UNKNOWN_SPEAKER
    return {
      id: `U-${String(i + 1).padStart(4, '0')}`,
      speaker_id: speakerId.get(key) as string,
      turn: i + 1,
      start_ms: r.start_ms,
      end_ms: r.end_ms,
      text: r.text,
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
