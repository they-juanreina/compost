// Minimal structural types for the rich transcript (schema/transcript.schema.json).
// The CLI reads transcripts produced by the Python transcriber; these types cover
// the fields the Node side consumes. Full validation lives in `compost validate`.

export interface TranscriptSpeaker {
  id: string
  name?: string
  type: 'moderator' | 'participant' | 'other'
}

export interface TranscriptWord {
  w: string
  s: number
  e: number
  conf?: number
}

export interface TranscriptProsody {
  volume?: 'low' | 'normal' | 'high'
  pace?: 'slow' | 'normal' | 'fast'
  hesitations?: number
}

export interface TranscriptUtterance {
  id: string
  speaker_id: string
  turn: number
  start_ms: number
  end_ms: number
  text: string
  words?: TranscriptWord[]
  prosody?: TranscriptProsody
  annotation?: string
}

export interface TranscriptSilence {
  id: string
  start_ms: number
  end_ms: number
  duration_ms: number
  context: 'after_question' | 'mid_utterance' | 'thinking' | 'interruption'
  annotation?: string
}

export interface TranscriptCue {
  id: string
  kind: string
  start_ms: number
  end_ms: number
  source: 'audio'
  speaker_id?: string
  confidence?: number
  annotation?: string
}

export interface Transcript {
  schema_version: string
  session_id: string
  source: string
  language: string
  duration_ms: number
  modality: string[]
  speakers: TranscriptSpeaker[]
  utterances: TranscriptUtterance[]
  silences?: TranscriptSilence[]
  cues?: TranscriptCue[]
  frames?: unknown[]
}

export function wordCount(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  return trimmed.split(/\s+/).length
}
