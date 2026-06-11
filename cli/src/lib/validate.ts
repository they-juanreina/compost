import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsImport from 'ajv-formats'
import Database from 'better-sqlite3'

import { CompostError } from '../errors.js'
import { eventsDbPath } from './events.js'
import {
  CUES_TAXONOMY,
  EVENTS_SCHEMA,
  FRAMES_TAXONOMY,
  TRANSCRIPT_SCHEMA,
} from './schemas.generated.js'

// ajv-formats ships CJS with a default export; under NodeNext ESM the runtime
// sees the namespace and the callable lives on `.default`.
type AddFormatsFn = (ajv: Ajv2020) => Ajv2020
const addFormats =
  (addFormatsImport as unknown as { default?: AddFormatsFn }).default ??
  (addFormatsImport as unknown as AddFormatsFn)

const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats(ajv)

type ValidatorFn = (data: unknown) => boolean

interface CompiledValidator {
  fn: ValidatorFn
  errors(): unknown
}

let transcriptValidator: CompiledValidator | null = null
let eventsValidator: CompiledValidator | null = null

function getTranscriptValidator(): CompiledValidator {
  if (transcriptValidator === null) {
    const fn = ajv.compile(TRANSCRIPT_SCHEMA)
    transcriptValidator = { fn, errors: () => fn.errors }
  }
  return transcriptValidator
}

function getEventsValidator(): CompiledValidator {
  if (eventsValidator === null) {
    const fn = ajv.compile(EVENTS_SCHEMA)
    eventsValidator = { fn, errors: () => fn.errors }
  }
  return eventsValidator
}

function getCuesTaxonomy(): { kinds: Array<{ kind: string }> } {
  return CUES_TAXONOMY as { kinds: Array<{ kind: string }> }
}

function getFramesTaxonomy(): { triggers: Array<{ trigger: string }> } {
  return FRAMES_TAXONOMY as { triggers: Array<{ trigger: string }> }
}

export interface ValidateResult {
  ok: boolean
  path: string
  schema: string
  errors: unknown
}

function readJson(path: string): unknown {
  if (!existsSync(path)) {
    throw new CompostError('FILE_NOT_FOUND', `No such file: ${path}`)
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new CompostError('INVALID_INPUT', `Failed to parse JSON at ${path}: ${String(err)}`)
  }
}

export function validateTranscript(path: string): ValidateResult {
  const data = readJson(path)
  const v = getTranscriptValidator()
  const ok = v.fn(data)
  return {
    ok,
    path,
    schema: 'transcript.schema.json',
    errors: ok ? null : v.errors(),
  }
}

export function validateEventsExport(path: string): ValidateResult {
  // The schema describes a single event; an export is typically a JSON array.
  // Accept either: an array → validate each; an object → validate as one event.
  const data = readJson(path)
  const v = getEventsValidator()
  if (Array.isArray(data)) {
    const errors: unknown[] = []
    for (const [i, evt] of data.entries()) {
      if (!v.fn(evt)) errors.push({ index: i, errors: v.errors() })
    }
    return {
      ok: errors.length === 0,
      path,
      schema: 'events.schema.json',
      errors: errors.length === 0 ? null : errors,
    }
  }
  const ok = v.fn(data)
  return {
    ok,
    path,
    schema: 'events.schema.json',
    errors: ok ? null : v.errors(),
  }
}

/**
 * Validate cue kinds in a transcript against the cues taxonomy.
 * Path may be a transcript.json (we inspect cues[]) or the taxonomy file itself
 * (sanity check of its own shape).
 */
export function validateCues(path: string): ValidateResult {
  const data = readJson(path)
  const taxonomy = getCuesTaxonomy()
  const allowed = new Set(taxonomy.kinds.map((k) => k.kind))

  if (Array.isArray((data as { kinds?: unknown }).kinds)) {
    // Treat as a taxonomy file — verify shape.
    const errors: string[] = []
    for (const k of (data as { kinds: Array<unknown> }).kinds) {
      if (
        typeof k !== 'object' ||
        k === null ||
        typeof (k as { kind?: unknown }).kind !== 'string'
      ) {
        errors.push(`taxonomy entry missing string 'kind': ${JSON.stringify(k)}`)
      }
    }
    return {
      ok: errors.length === 0,
      path,
      schema: 'cues.taxonomy.json',
      errors: errors.length === 0 ? null : errors,
    }
  }

  // Treat as a transcript — check cues[].kind values against the taxonomy.
  const cues = (data as { cues?: Array<{ kind?: unknown }> }).cues ?? []
  const errors: Array<{ index: number; kind: unknown; reason: string }> = []
  for (const [i, cue] of cues.entries()) {
    if (typeof cue.kind !== 'string' || !allowed.has(cue.kind)) {
      errors.push({ index: i, kind: cue.kind, reason: `not in cues taxonomy` })
    }
  }
  return {
    ok: errors.length === 0,
    path,
    schema: 'cues.taxonomy.json',
    errors: errors.length === 0 ? null : errors,
  }
}

export interface SeedEventsResult {
  ok: boolean
  checked: number
  errors: unknown
}

export interface SeedValidateResult {
  ok: boolean
  seed: string
  transcripts: ValidateResult[]
  events: SeedEventsResult | null
}

/** Validate every event row in a seed's .compost/events.sqlite against the
 * events schema. Null columns are stripped (the schema's optional fields are
 * typed strings, and rows carry NULLs for absent ones); payload is parsed and
 * always kept (it is required). Returns null when there is no event log. */
function validateSeedEvents(dbPath: string): SeedEventsResult | null {
  if (!existsSync(dbPath)) return null
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare('SELECT * FROM events').all() as Array<Record<string, unknown>>
    const v = getEventsValidator()
    const errors: unknown[] = []
    for (const [i, row] of rows.entries()) {
      const clean: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(row)) {
        if (k === 'payload') continue
        if (val !== null) clean[k] = val
      }
      clean.payload =
        typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? null)
      if (!v.fn(clean)) errors.push({ index: i, id: row.id, errors: v.errors() })
    }
    return {
      ok: errors.length === 0,
      checked: rows.length,
      errors: errors.length === 0 ? null : errors,
    }
  } finally {
    db.close()
  }
}

/**
 * Whole-seed validation (#174): validate every session transcript.json and every
 * normalized legacy/*.json against the transcript schema (which already enforces
 * cue kinds and frame triggers via its enums), plus every provenance event in
 * .compost/events.sqlite. Aggregates to a single ok.
 */
export function validateSeed(seedPath: string): SeedValidateResult {
  if (!existsSync(seedPath)) {
    throw new CompostError('FILE_NOT_FOUND', `No such seed directory: ${seedPath}`)
  }
  const transcripts: ValidateResult[] = []
  const sessionsDir = join(seedPath, 'sessions')
  if (existsSync(sessionsDir)) {
    for (const entry of readdirSync(sessionsDir)) {
      if (entry === '_inbox' || entry.startsWith('.')) continue
      const tp = join(sessionsDir, entry, 'transcript.json')
      if (existsSync(tp)) transcripts.push(validateTranscript(tp))
    }
  }
  const legacyDir = join(seedPath, 'legacy')
  if (existsSync(legacyDir)) {
    for (const f of readdirSync(legacyDir)) {
      if (f.endsWith('.json')) transcripts.push(validateTranscript(join(legacyDir, f)))
    }
  }
  const events = validateSeedEvents(eventsDbPath(seedPath))
  const ok = transcripts.every((t) => t.ok) && (events === null || events.ok)
  return { ok, seed: seedPath, transcripts, events }
}

export function validateFrames(path: string): ValidateResult {
  const data = readJson(path)
  const taxonomy = getFramesTaxonomy()
  const allowed = new Set(taxonomy.triggers.map((t) => t.trigger))

  if (Array.isArray((data as { triggers?: unknown }).triggers)) {
    const errors: string[] = []
    for (const t of (data as { triggers: Array<unknown> }).triggers) {
      if (
        typeof t !== 'object' ||
        t === null ||
        typeof (t as { trigger?: unknown }).trigger !== 'string'
      ) {
        errors.push(`taxonomy entry missing string 'trigger': ${JSON.stringify(t)}`)
      }
    }
    return {
      ok: errors.length === 0,
      path,
      schema: 'frames.taxonomy.json',
      errors: errors.length === 0 ? null : errors,
    }
  }

  const frames = (data as { frames?: Array<{ trigger?: unknown }> }).frames ?? []
  const errors: Array<{ index: number; trigger: unknown; reason: string }> = []
  for (const [i, frame] of frames.entries()) {
    if (typeof frame.trigger !== 'string' || !allowed.has(frame.trigger)) {
      errors.push({ index: i, trigger: frame.trigger, reason: `not in frames taxonomy` })
    }
  }
  return {
    ok: errors.length === 0,
    path,
    schema: 'frames.taxonomy.json',
    errors: errors.length === 0 ? null : errors,
  }
}
