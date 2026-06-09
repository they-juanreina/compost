import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CompostError } from '../errors.js'
import type { Transcript, TranscriptSpeaker } from './transcript.js'

/**
 * Speaker labeling (#177). Diarization emits cluster ids (S0, S1, … — pyannote's
 * SPEAKER_NN canonicalized to the schema's S{n} form) with name == id; this maps
 * them to real names. The map is applied to transcript.json
 * AND persisted to a `speakers.json` sidecar next to it, so re-transcription
 * re-applies the names (diarization cluster ids are stable per session).
 */

export type SpeakerType = TranscriptSpeaker['type']

export interface SpeakerLabel {
  name?: string
  type?: SpeakerType
}

export type SpeakerMap = Record<string, SpeakerLabel>

export function sidecarPath(seedPath: string, session: string): string {
  return join(seedPath, 'sessions', session, 'speakers.json')
}

function transcriptPath(seedPath: string, session: string): string {
  return join(seedPath, 'sessions', session, 'transcript.json')
}

/** Apply a label map to a transcript's speakers[] in place. Returns the cluster
 * ids that matched a real speaker and the map keys that matched none. */
export function applyLabels(
  transcript: Transcript,
  map: SpeakerMap,
): { applied: string[]; unmatched: string[] } {
  const ids = new Set(transcript.speakers.map((s) => s.id))
  const applied: string[] = []
  for (const sp of transcript.speakers) {
    const label = map[sp.id]
    if (label === undefined) continue
    if (label.name !== undefined) sp.name = label.name
    if (label.type !== undefined) sp.type = label.type
    applied.push(sp.id)
  }
  const unmatched = Object.keys(map).filter((id) => !ids.has(id))
  return { applied, unmatched }
}

export function readSidecar(path: string): SpeakerMap {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as SpeakerMap) : {}
  } catch {
    return {}
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export interface LabelResult {
  session: string
  applied: string[]
  unmatched: string[]
  transcript_path: string
  sidecar_path: string
}

/**
 * Label a session's speakers: apply the map to transcript.json, then merge it
 * into the persisted speakers.json sidecar so it survives re-transcription.
 */
export function labelSession(seedPath: string, session: string, map: SpeakerMap): LabelResult {
  const tPath = transcriptPath(seedPath, session)
  if (!existsSync(tPath)) {
    throw new CompostError(
      'FILE_NOT_FOUND',
      `No transcript.json for session ${session} — transcribe it before labeling.`,
    )
  }
  const transcript = JSON.parse(readFileSync(tPath, 'utf8')) as Transcript
  const { applied, unmatched } = applyLabels(transcript, map)
  writeJson(tPath, transcript)

  const sPath = sidecarPath(seedPath, session)
  const merged = { ...readSidecar(sPath), ...map }
  writeJson(sPath, merged)

  return { session, applied, unmatched, transcript_path: tPath, sidecar_path: sPath }
}

/**
 * Re-apply a session's persisted speaker labels to a freshly-written
 * transcript.json (called from the transcribe finalize step). No-op when there
 * is no sidecar. Returns the cluster ids relabeled.
 */
export function applySidecar(transcriptJsonPath: string): string[] {
  const dir = transcriptJsonPath.slice(0, transcriptJsonPath.lastIndexOf('/'))
  const sPath = join(dir, 'speakers.json')
  if (!existsSync(sPath) || !existsSync(transcriptJsonPath)) return []
  const map = readSidecar(sPath)
  if (Object.keys(map).length === 0) return []
  const transcript = JSON.parse(readFileSync(transcriptJsonPath, 'utf8')) as Transcript
  const { applied } = applyLabels(transcript, map)
  if (applied.length > 0) writeJson(transcriptJsonPath, transcript)
  return applied
}
