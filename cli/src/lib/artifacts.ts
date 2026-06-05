import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import Database from 'better-sqlite3'

import { CompostError } from '../errors.js'
import { type Author, artifactId, emitCreate, emitEndorse, openSeedEvents } from './events.js'

export interface CreatedArtifact {
  id: string // human/file id (H-NNN, C-slug, T-slug)
  artifact_id: string // SHA256(initial state) — the provenance content-address
  path: string // markdown file written
  event_id: string // the create event's ULID
}

// ---------------------------------------------------------------- helpers

/** Next sequential H-NNN in highlights/, scanning existing files. */
function nextHighlightId(dir: string): string {
  let max = 0
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const m = /^H-(\d+)\.md$/.exec(f)
      if (m) max = Math.max(max, Number.parseInt(m[1] as string, 10))
    }
  }
  return `H-${String(max + 1).padStart(3, '0')}`
}

/** Filesystem-safe slug for code/theme names. */
function slug(name: string): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length === 0)
    throw new CompostError(
      'INVALID_INPUT',
      `Name has no slug-able characters: ${JSON.stringify(name)}`,
    )
  return s
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${formatYamlValue(v)}`)
  return `---\n${lines.join('\n')}\n---\n`
}

function formatYamlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => String(x)).join(', ')}]`
  if (typeof v === 'object' && v !== null) {
    const inner = Object.entries(v)
      .map(([k, val]) => `${k}: ${String(val)}`)
      .join(', ')
    return `{ ${inner} }`
  }
  return String(v)
}

// ---------------------------------------------------------------- create

/**
 * Write the markdown, then emit its create event — atomically. If the event
 * fails (e.g. schema validation: AI events require model + prompt_hash), roll
 * the file back so no code path ever leaves a `.md` without a matching create
 * event (#165). The caller guarantees `path` did not pre-exist (existsSync
 * check / fresh sequential id), so the rollback only removes our own write.
 */
function writeArtifactAtomic(
  seedPath: string,
  path: string,
  body: string,
  event: { artifactKind: string; initialState: Record<string, unknown>; author: Author },
): string {
  writeFileSync(path, body, 'utf8')
  const events = openSeedEvents(seedPath)
  try {
    return emitCreate(events, event).id
  } catch (err) {
    try {
      rmSync(path, { force: true }) // roll back the orphan-to-be
    } catch {
      // best-effort cleanup; surface the original (more useful) error regardless
    }
    throw err
  } finally {
    events.close()
  }
}

export interface CreateHighlightInput {
  sessionId: string
  utteranceId: string
  span: [number, number]
  text: string
  author: Author
}

export function createHighlight(seedPath: string, input: CreateHighlightInput): CreatedArtifact {
  const dir = join(seedPath, 'highlights')
  mkdirSync(dir, { recursive: true })
  const id = nextHighlightId(dir)

  // initialState is what the SHA addresses — the artifact's identity at birth.
  const initialState = {
    id,
    kind: 'highlight',
    session_id: input.sessionId,
    utterance_id: input.utteranceId,
    span: input.span,
    text: input.text,
  }
  const sha = artifactId(initialState)
  const body = `${frontmatter({
    id,
    session_id: input.sessionId,
    utterance_id: input.utteranceId,
    span: input.span,
    artifact_id: sha,
    provenance: { actor_type: input.author.actorType, actor_id: input.author.actorId },
  })}\n${input.text}\n`

  const path = join(dir, `${id}.md`)
  const event_id = writeArtifactAtomic(seedPath, path, body, {
    artifactKind: 'highlight',
    initialState,
    author: input.author,
  })
  return { id, artifact_id: sha, path, event_id }
}

export interface CreateCodeInput {
  name: string
  definition: string
  evidence?: string[]
  author: Author
}

export function createCode(seedPath: string, input: CreateCodeInput): CreatedArtifact {
  const dir = join(seedPath, 'codebook')
  mkdirSync(dir, { recursive: true })
  const name = slug(input.name)
  const id = `C-${name}`
  const evidence = input.evidence ?? []

  const initialState = { id, kind: 'code', name, definition: input.definition, evidence }
  const sha = artifactId(initialState)
  const body = `${frontmatter({
    id,
    name,
    evidence,
    artifact_id: sha,
    provenance: { actor_type: input.author.actorType, actor_id: input.author.actorId },
  })}\n${input.definition}\n`

  const path = join(dir, `${name}.md`)
  if (existsSync(path)) {
    throw new CompostError('INVALID_INPUT', `Code "${id}" already exists at ${path}`)
  }
  const event_id = writeArtifactAtomic(seedPath, path, body, {
    artifactKind: 'code',
    initialState,
    author: input.author,
  })
  return { id, artifact_id: sha, path, event_id }
}

export interface CreateThemeInput {
  name: string
  summary: string
  codes?: string[]
  author: Author
}

export function createTheme(seedPath: string, input: CreateThemeInput): CreatedArtifact {
  const dir = join(seedPath, 'synthesis', 'themes')
  mkdirSync(dir, { recursive: true })
  const name = slug(input.name)
  const id = `T-${name}`
  const codes = input.codes ?? []

  const initialState = { id, kind: 'theme', name, summary: input.summary, codes }
  const sha = artifactId(initialState)
  const title = input.name.trim()
  const body = `${frontmatter({
    id,
    name,
    codes,
    artifact_id: sha,
    provenance: { actor_type: input.author.actorType, actor_id: input.author.actorId },
  })}\n# ${title}\n\n${input.summary}\n`

  const path = join(dir, `${name}.md`)
  if (existsSync(path)) {
    throw new CompostError('INVALID_INPUT', `Theme "${id}" already exists at ${path}`)
  }
  const event_id = writeArtifactAtomic(seedPath, path, body, {
    artifactKind: 'theme',
    initialState,
    author: input.author,
  })
  return { id, artifact_id: sha, path, event_id }
}

// ---------------------------------------------------------------- endorse

interface CreateEventRow {
  id: string
  artifact_kind: string
}

/**
 * Human-id form for an artifact ref: `H-NNN`, `C-slug`, `T-slug` — the id
 * `compost create` prints. We accept it wherever a SHA prefix is accepted so
 * the obvious `endorse <id-from-create>` round-trip works (#168). The dash and
 * non-hex chars make it unambiguous vs a SHA prefix (`^[a-f0-9]{8,64}$`).
 */
export const HUMAN_REF_RE = /^[CHT]-[A-Za-z0-9_-]+$/

/**
 * Look up a create event by the human id stored in its payload (initialState.id).
 * Returns undefined when the ref isn't a human id OR no matching create exists,
 * so callers can fall through to SHA-prefix / latest: handling.
 */
export function tryResolveHumanRef(
  db: Database.Database,
  ref: string,
): (CreateEventRow & { artifact_id: string }) | undefined {
  if (!HUMAN_REF_RE.test(ref)) return undefined
  return db
    .prepare(
      "SELECT id, artifact_kind, artifact_id FROM events WHERE action = 'create' AND json_extract(payload, '$.id') = ? ORDER BY ts, rowid LIMIT 1",
    )
    .get(ref) as (CreateEventRow & { artifact_id: string }) | undefined
}

/**
 * Resolve an artifact ref (human id, full/prefix SHA, or `latest:<kind>=<seed>`)
 * to its create event, then emit a researcher endorse chaining it. Mirrors
 * blame's ref resolution so `compost endorse <id-from-create>` works (#168).
 */
export function endorseArtifact(
  seedPath: string,
  artifactRef: string,
  researcherId: string,
): { artifact_id: string; endorse_event_id: string; parent_event_id: string } {
  const eventsDb = join(seedPath, '.compost', 'events.sqlite')
  if (!existsSync(eventsDb)) {
    throw new CompostError('FILE_NOT_FOUND', `No events.sqlite in seed; nothing to endorse.`)
  }
  const db = new Database(eventsDb, { readonly: true, fileMustExist: true })
  let createRow: (CreateEventRow & { artifact_id: string }) | undefined
  try {
    createRow = tryResolveHumanRef(db, artifactRef)
    if (createRow === undefined) {
      const latest = /^latest:(\w+)=(.+)$/.exec(artifactRef)
      if (latest) {
        const kind = latest[1] as string
        createRow = db
          .prepare(
            "SELECT id, artifact_kind, artifact_id FROM events WHERE artifact_kind = ? AND action = 'create' ORDER BY ts DESC, rowid DESC LIMIT 1",
          )
          .get(kind) as (CreateEventRow & { artifact_id: string }) | undefined
      } else if (/^[a-f0-9]{8,64}$/i.test(artifactRef)) {
        createRow = db
          .prepare(
            "SELECT id, artifact_kind, artifact_id FROM events WHERE artifact_id LIKE ? AND action = 'create' ORDER BY ts, rowid LIMIT 1",
          )
          .get(`${artifactRef.toLowerCase()}%`) as
          | (CreateEventRow & { artifact_id: string })
          | undefined
      } else if (!HUMAN_REF_RE.test(artifactRef)) {
        // Not human-shaped, not SHA-shaped, not latest: → user typed something
        // unparseable. (Human-shaped refs that didn't resolve fall through to
        // the FILE_NOT_FOUND below with a clearer message.)
        throw new CompostError(
          'INVALID_INPUT',
          `Invalid artifact ref "${artifactRef}". Use the id from \`compost create\` (e.g. C-slug, H-001), a SHA256 prefix, or latest:<kind>=<seed>.`,
        )
      }
    }
  } finally {
    db.close()
  }

  if (createRow === undefined) {
    throw new CompostError('FILE_NOT_FOUND', `No create event found for ref "${artifactRef}".`)
  }

  const events = openSeedEvents(seedPath)
  try {
    const endorse = emitEndorse(events, {
      artifactKind: createRow.artifact_kind,
      artifactId: createRow.artifact_id,
      parentEventId: createRow.id,
      researcherId,
    })
    return {
      artifact_id: createRow.artifact_id,
      endorse_event_id: endorse.id,
      parent_event_id: createRow.id,
    }
  } finally {
    events.close()
  }
}

/** Read the configured researcher identity: COMPOST_USER env, else fallback. */
export function defaultResearcherId(): string {
  return process.env.COMPOST_USER || process.env.USER || 'researcher'
}
