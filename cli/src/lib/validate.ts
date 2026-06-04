import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsImport from 'ajv-formats'

import { CompostError } from '../errors.js'

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

const SCHEMA_ROOT = (() => {
  // schemas live at <repo>/schema/; the CLI runs from anywhere, so resolve
  // relative to the file's expected install location. dist is bin-published.
  // In dev (tsx) __dirname points at src/lib; in built form it points at dist/lib.
  // Either way schema/ is two levels up.
  return resolve(import.meta.dirname, '..', '..', '..', 'schema')
})()

function loadSchema(name: string): Record<string, unknown> {
  const path = join(SCHEMA_ROOT, name)
  if (!existsSync(path)) {
    throw new CompostError('FILE_NOT_FOUND', `Schema file not found: ${path}`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

let transcriptValidator: CompiledValidator | null = null
let eventsValidator: CompiledValidator | null = null
let cuesTaxonomy: { kinds: Array<{ kind: string }> } | null = null
let framesTaxonomy: { triggers: Array<{ trigger: string }> } | null = null

function getTranscriptValidator(): CompiledValidator {
  if (transcriptValidator === null) {
    const schema = loadSchema('transcript.schema.json')
    const fn = ajv.compile(schema)
    transcriptValidator = { fn, errors: () => fn.errors }
  }
  return transcriptValidator
}

function getEventsValidator(): CompiledValidator {
  if (eventsValidator === null) {
    const schema = loadSchema('events.schema.json')
    const fn = ajv.compile(schema)
    eventsValidator = { fn, errors: () => fn.errors }
  }
  return eventsValidator
}

function getCuesTaxonomy(): { kinds: Array<{ kind: string }> } {
  if (cuesTaxonomy === null) {
    cuesTaxonomy = loadSchema('cues.taxonomy.json') as { kinds: Array<{ kind: string }> }
  }
  return cuesTaxonomy
}

function getFramesTaxonomy(): { triggers: Array<{ trigger: string }> } {
  if (framesTaxonomy === null) {
    framesTaxonomy = loadSchema('frames.taxonomy.json') as {
      triggers: Array<{ trigger: string }>
    }
  }
  return framesTaxonomy
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
