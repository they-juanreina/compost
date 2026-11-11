import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'

import Database from 'better-sqlite3'

import { CompostError } from '../errors.js'
import { defaultResearcherId } from './artifacts.js'
import { emitAgentCreate, emitCreate, eventsDbPath, openSeedEvents } from './events.js'

/**
 * Ingest provenance (ADR 0006, #325). A transcript is ingested *source* data —
 * attributed, never endorsable — so landing one emits exactly ONE append-only
 * `transcript_ingest` event answering "where did this session come from, in what
 * format, who landed it, when?". There is deliberately no `[draft]` and no
 * endorse step: the event is provenance, not an interpretation.
 *
 * `recordTranscriptIngest` is the single seam. The sync `import` path and the
 * queue workers do NOT share a transcript assembler (the queue's transcripts are
 * produced by the Python transcriber / legacy normalizer, not
 * `assembleTranscript`), so the one shared point is this function; every landing
 * site calls it, and it is idempotent per (session, sha256), so a retry or a
 * second path over the same file cannot double-emit.
 */

export const INGEST_ARTIFACT_KIND = 'transcript_ingest'

/** Closed set of source formats — the file extension that selected the parser. */
export const INGEST_FORMATS = [
  'txt',
  'md',
  'markdown',
  'vtt',
  'srt',
  'pdf',
  'docx',
  'pptx',
  'csv',
  'tsv',
  'xlsx',
  'mp3',
  'wav',
  'm4a',
  'aac',
  'flac',
  'ogg',
  'opus',
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'm4v',
] as const
export type IngestFormat = (typeof INGEST_FORMATS)[number]

/** Closed set of components that can land a transcript. */
export const INGEST_PARSERS = [
  'compost-import',
  'compost-transcribe',
  'transcribe-worker',
  'legacy-ingest-worker',
] as const
export type IngestParser = (typeof INGEST_PARSERS)[number]

/** Who landed it: `researcher` = CLI `import`; `agent` = the queue worker. */
export type IngestActor = 'researcher' | 'agent'

export interface TranscriptIngestPayload {
  /** Which session the transcript landed in (links the event to `blame <session>`). */
  session_id: string
  original_name: string
  source_uri?: string
  format: IngestFormat
  parser: IngestParser
  parser_version: string
  ingested_at: string
  actor: IngestActor
  /** SHA-256 (hex) of the ORIGINAL source file bytes. */
  sha256: string
}

export type IngestAuthor =
  | { type: 'researcher'; id?: string }
  | { type: 'agent'; name: string; version: string }

export interface RecordIngestInput {
  sessionId: string
  originalName: string
  sourceUri?: string
  format: IngestFormat
  parser: IngestParser
  parserVersion: string
  sha256: string
  author: IngestAuthor
  now?: () => Date
}

export interface RecordIngestResult {
  /** The new event's id; null when an identical (session, sha256) ingest already existed. */
  event_id: string | null
  /** Other sessions in this seed already ingested from the same bytes. */
  duplicate_of: string[]
}

/** Format of a source file by extension. An unrecognized extension was parsed as
 * text by `import`, so it is recorded as `txt`. */
export function ingestFormatOf(nameOrPath: string): IngestFormat {
  const ext = extname(nameOrPath).slice(1).toLowerCase()
  return (INGEST_FORMATS as readonly string[]).includes(ext) ? (ext as IngestFormat) : 'txt'
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Chunked sync hash — media sources can be gigabytes, so never slurp them. */
export function sha256File(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      hash.update(buf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** Every transcript-ingest payload in a seed's ledger, oldest first. [] when the
 * seed has no ledger yet. Read-only — never scaffolds `.compost/`. */
export function listTranscriptIngests(seedPath: string): TranscriptIngestPayload[] {
  const dbPath = eventsDbPath(seedPath)
  if (!existsSync(dbPath)) return []
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare(
        "SELECT payload FROM events WHERE artifact_kind = ? AND action = 'create' ORDER BY ts, id",
      )
      .all(INGEST_ARTIFACT_KIND) as Array<{ payload: string }>
    return rows.map((r) => JSON.parse(r.payload) as TranscriptIngestPayload)
  } finally {
    db.close()
  }
}

export interface DuplicateIngest {
  sha256: string
  /** Number of sessions ingested from these exact bytes. */
  count: number
  sessions: string[]
  original_names: string[]
}

/** sha256s ingested into more than one session of the seed. Informational —
 * `import` never blocks on it (a researcher may re-land a file on purpose). */
export function findDuplicateIngests(seedPath: string): DuplicateIngest[] {
  const bySha = new Map<string, TranscriptIngestPayload[]>()
  for (const p of listTranscriptIngests(seedPath)) {
    bySha.set(p.sha256, [...(bySha.get(p.sha256) ?? []), p])
  }
  const out: DuplicateIngest[] = []
  for (const [sha256, ps] of bySha) {
    const sessions = [...new Set(ps.map((p) => p.session_id))]
    if (sessions.length < 2) continue
    out.push({
      sha256,
      count: sessions.length,
      sessions,
      original_names: [...new Set(ps.map((p) => p.original_name))],
    })
  }
  return out
}

/**
 * Emit the ONE ingest-provenance event for a transcript that just landed in
 * `sessions/<id>/`. Idempotent per (session, sha256): a worker retry, or a second
 * path over the same bytes into the same session, emits nothing the second time.
 */
export function recordTranscriptIngest(
  seedPath: string,
  input: RecordIngestInput,
): RecordIngestResult {
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new CompostError(
      'INVALID_INPUT',
      `Ingest sha256 must be 64 lowercase hex chars (got ${JSON.stringify(input.sha256)}) — hash the original source file bytes.`,
    )
  }
  const prior = listTranscriptIngests(seedPath)
  if (prior.some((p) => p.session_id === input.sessionId && p.sha256 === input.sha256)) {
    return { event_id: null, duplicate_of: duplicateSessions(prior, input) }
  }

  const payload: TranscriptIngestPayload = {
    session_id: input.sessionId,
    original_name: input.originalName,
    ...(input.sourceUri !== undefined ? { source_uri: input.sourceUri } : {}),
    format: input.format,
    parser: input.parser,
    parser_version: input.parserVersion,
    ingested_at: (input.now ?? (() => new Date()))().toISOString(),
    actor: input.author.type,
    sha256: input.sha256,
  }
  const events = openSeedEvents(seedPath)
  try {
    const event =
      input.author.type === 'researcher'
        ? emitCreate(events, {
            artifactKind: INGEST_ARTIFACT_KIND,
            initialState: { ...payload },
            author: { actorType: 'researcher', actorId: input.author.id ?? defaultResearcherId() },
          })
        : emitAgentCreate(events, {
            artifactKind: INGEST_ARTIFACT_KIND,
            initialState: { ...payload },
            agentName: input.author.name,
            agentVersion: input.author.version,
          })
    return { event_id: event.id, duplicate_of: duplicateSessions(prior, input) }
  } finally {
    events.close()
  }
}

function duplicateSessions(prior: TranscriptIngestPayload[], input: RecordIngestInput): string[] {
  return [
    ...new Set(
      prior
        .filter((p) => p.sha256 === input.sha256 && p.session_id !== input.sessionId)
        .map((p) => p.session_id),
    ),
  ]
}

/**
 * Queue-worker landing (actor `agent`): hash the job's source file and record the
 * ingest. `original_name` comes from the job payload when the inbox renamed the
 * file to `source.<ext>`; `source_uri` is only recorded when the file was NOT
 * moved (a moved file's original location is gone, so a URI would be a lie).
 */
export function recordQueueIngest(
  seedPath: string,
  sessionId: string,
  sourcePath: string,
  payload: Record<string, unknown>,
  worker: { parser: IngestParser; version: string },
): RecordIngestResult {
  const original = typeof payload.original_name === 'string' ? payload.original_name : undefined
  return recordTranscriptIngest(seedPath, {
    sessionId,
    originalName: original ?? basename(sourcePath),
    ...(original === undefined ? { sourceUri: pathToFileURL(sourcePath).href } : {}),
    format: ingestFormatOf(original ?? sourcePath),
    parser: worker.parser,
    parserVersion: worker.version,
    sha256: sha256File(sourcePath),
    author: { type: 'agent', name: worker.parser, version: worker.version },
  })
}
