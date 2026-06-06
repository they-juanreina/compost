import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import Database from 'better-sqlite3'

import { CompostError } from '../errors.js'
import { HUMAN_REF_RE, tryResolveHumanRef } from './artifacts.js'

export interface BlameEvent {
  id: string
  ts: string
  artifact_kind: string
  artifact_id: string
  action: string
  actor_type: 'researcher' | 'agent' | 'ai'
  actor_id: string
  agent_name: string | null
  agent_version: string | null
  prompt_hash: string | null
  model: string | null
  payload: unknown
  parent_event: string | null
  batch_id: string | null
}

export interface BlameResult {
  schema_version: '1.0'
  query: string
  resolved_artifact_id: string
  seed: string
  events: BlameEvent[]
}

export interface BlameOptions {
  cwd?: string
  seed?: string
}

const ARTIFACT_PREFIX_RE = /^[a-f0-9]{8,64}$/i
const LATEST_REF_RE = /^latest:(\w+)=(.+)$/

interface EventRow {
  id: string
  ts: string
  artifact_kind: string
  artifact_id: string
  action: string
  actor_type: string
  actor_id: string
  agent_name: string | null
  agent_version: string | null
  prompt_hash: string | null
  model: string | null
  payload: string
  parent_event: string | null
  batch_id: string | null
}

export function blame(query: string, opts: BlameOptions = {}): BlameResult {
  const cwd = opts.cwd ?? process.cwd()
  const seedName = resolveSeedForBlame(query, opts.seed, cwd)
  const eventsDb = resolve(cwd, 'Seeds', seedName, '.compost', 'events.sqlite')

  if (!existsSync(eventsDb)) {
    throw new CompostError(
      'FILE_NOT_FOUND',
      `No events.sqlite at ${eventsDb}. Has any artifact been created in seed "${seedName}"?`,
    )
  }

  const db = new Database(eventsDb, { readonly: true, fileMustExist: true })
  try {
    const artifactId = resolveArtifactId(db, query, seedName)
    const rows = db
      .prepare('SELECT * FROM events WHERE artifact_id = ? ORDER BY ts, rowid')
      .all(artifactId) as EventRow[]
    return {
      schema_version: '1.0',
      query,
      resolved_artifact_id: artifactId,
      seed: seedName,
      events: rows.map(rowToEvent),
    }
  } finally {
    db.close()
  }
}

function rowToEvent(row: EventRow): BlameEvent {
  return {
    id: row.id,
    ts: row.ts,
    artifact_kind: row.artifact_kind,
    artifact_id: row.artifact_id,
    action: row.action,
    actor_type: row.actor_type as BlameEvent['actor_type'],
    actor_id: row.actor_id,
    agent_name: row.agent_name,
    agent_version: row.agent_version,
    prompt_hash: row.prompt_hash,
    model: row.model,
    payload: JSON.parse(row.payload) as unknown,
    parent_event: row.parent_event,
    batch_id: row.batch_id,
  }
}

function resolveArtifactId(db: Database.Database, query: string, seed: string): string {
  // Human id (H-NNN / C-slug / T-slug) — the form `compost create` prints (#168).
  // Tried first so a human ref short-circuits before the SHA/latest branches.
  const humanRow = tryResolveHumanRef(db, query)
  if (humanRow !== undefined) return humanRow.artifact_id
  if (HUMAN_REF_RE.test(query)) {
    throw new CompostError('FILE_NOT_FOUND', `No artifact with id "${query}" in seed "${seed}".`)
  }

  const latestMatch = LATEST_REF_RE.exec(query)
  if (latestMatch !== null) {
    const [, kind, target] = latestMatch
    if (target !== seed) {
      throw new CompostError(
        'INVALID_INPUT',
        `latest: ref points at seed "${target}" but we resolved seed "${seed}"`,
      )
    }
    const row = db
      .prepare(
        'SELECT artifact_id FROM events WHERE artifact_kind = ? AND action = ? ORDER BY ts DESC, rowid DESC LIMIT 1',
      )
      .get(kind, 'create') as { artifact_id: string } | undefined
    if (row === undefined) {
      throw new CompostError('FILE_NOT_FOUND', `No "${kind}" artifacts found in seed "${seed}"`)
    }
    return row.artifact_id
  }

  if (!ARTIFACT_PREFIX_RE.test(query)) {
    throw new CompostError(
      'INVALID_INPUT',
      `Invalid artifact ref "${query}". Expected the id from \`compost create\` (e.g. C-slug, H-001), a SHA256 prefix (8-64 hex chars), or "latest:<kind>=<seed>".`,
    )
  }

  if (query.length === 64) return query.toLowerCase()

  const matches = db
    .prepare('SELECT DISTINCT artifact_id FROM events WHERE artifact_id LIKE ?')
    .all(`${query.toLowerCase()}%`) as Array<{ artifact_id: string }>
  if (matches.length === 0) {
    throw new CompostError(
      'FILE_NOT_FOUND',
      `No artifact found matching prefix "${query}" in seed "${seed}"`,
    )
  }
  if (matches.length > 1) {
    throw new CompostError(
      'INVALID_INPUT',
      `Prefix "${query}" is ambiguous (${matches.length} matches). Use more characters.`,
    )
  }
  // biome-ignore lint/style/noNonNullAssertion: length checked === 0 and > 1 above, so exactly one match remains
  return matches[0]!.artifact_id
}

/**
 * Resolve the seed name for a blame query.
 *
 * Precedence:
 *  1. Explicit `--seed` flag — wins, but errors if a `latest:kind=seed` ref
 *     embeds a different name.
 *  2. Seed embedded in the ref (`latest:kind=<seed>`) — used when no flag is
 *     given; skips the multi-seed singleton check (the ref already disambiguates).
 *  3. Fall back to `findSingletonSeed`, which errors in multi-seed workspaces.
 *
 * The earlier bug: precedence (3) fired before (2) was considered, so
 * `compost blame latest:ingest_job=Lineage` errored in a multi-seed workspace
 * even though the ref already named the seed.
 */
function resolveSeedForBlame(query: string, seedFlag: string | undefined, cwd: string): string {
  const latestMatch = LATEST_REF_RE.exec(query)
  const seedFromRef = latestMatch !== null ? latestMatch[2] : undefined

  if (seedFlag !== undefined && seedFromRef !== undefined && seedFlag !== seedFromRef) {
    // When the only difference is case AND the flag's exact-cased name is not
    // a directory entry, the user almost certainly mistyped — surface that
    // instead of the misleading generic "disagrees" message.
    //
    // We readdirSync rather than existsSync because macOS HFS+/APFS is
    // case-insensitive by default: existsSync('Seeds/lineage') returns true
    // even when only 'Seeds/Lineage' is on disk. readdir gives us the actual
    // directory entry names.
    if (seedFlag.toLowerCase() === seedFromRef.toLowerCase()) {
      const root = resolve(cwd, 'Seeds')
      const entries = existsSync(root) ? readdirSync(root) : []
      if (!entries.includes(seedFlag)) {
        throw new CompostError(
          'INVALID_INPUT',
          `Seed names are case-sensitive; "${seedFlag}" does not exist. Did you mean "${seedFromRef}"?`,
        )
      }
    }
    throw new CompostError(
      'INVALID_INPUT',
      `--seed "${seedFlag}" disagrees with ref-embedded seed "${seedFromRef}"`,
    )
  }
  return seedFlag ?? seedFromRef ?? findSingletonSeed(cwd)
}

function findSingletonSeed(cwd: string): string {
  const root = resolve(cwd, 'Seeds')
  if (!existsSync(root)) {
    throw new CompostError(
      'NOT_IN_SEED',
      `No Seeds/ at ${root}. Pass --seed <name> or run from a directory containing one.`,
    )
  }
  const entries = readdirSync(root).filter(
    (e) => !e.startsWith('.') && statSync(join(root, e)).isDirectory(),
  )
  if (entries.length === 0) {
    throw new CompostError('NOT_IN_SEED', `No seeds found under ${root}`)
  }
  if (entries.length > 1) {
    throw new CompostError(
      'INVALID_INPUT',
      `Multiple seeds under ${root} (${entries.join(', ')}). Pass --seed <name>.`,
    )
  }
  // biome-ignore lint/style/noNonNullAssertion: length checked === 0 and > 1 above, so exactly one entry remains
  return entries[0]!
}

export function renderHuman(result: BlameResult): string {
  const lines: string[] = []
  lines.push(
    `blame ${result.resolved_artifact_id.slice(0, 12)}… (${result.events.length} events in seed "${result.seed}")`,
  )
  for (const e of result.events) {
    const tag =
      e.actor_type === 'ai'
        ? `[ai] ${e.model ?? '?'}`
        : e.actor_type === 'agent'
          ? `[agent] ${e.agent_name ?? '?'}@${e.agent_version ?? '?'}`
          : `[researcher] ${e.actor_id}`
    lines.push('')
    lines.push(`event ${e.id}`)
    lines.push(`  ${e.action.padEnd(8)} ${e.ts}`)
    lines.push(`  ${tag}`)
    if (e.parent_event !== null) lines.push(`  parent ${e.parent_event}`)
    if (e.batch_id !== null) lines.push(`  batch  ${e.batch_id}`)
    if (e.prompt_hash !== null) lines.push(`  prompt ${e.prompt_hash.slice(0, 12)}…`)
  }
  return lines.join('\n')
}
