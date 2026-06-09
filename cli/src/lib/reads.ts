import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type Event, reduce, type Snapshot } from '@they-juanreina/compost-provenance'
import Database from 'better-sqlite3'

/** A current snapshot plus the timestamp of its latest event, so callers can
 * sort by recency ("recent activity on top") without a second query. */
export interface SnapshotView extends Snapshot {
  last_event_ts: string
}

interface EventRow {
  id: string
  ts: string
  artifact_kind: string
  artifact_id: string
  action: Event['action']
  actor_type: Event['actor_type']
  actor_id: string
  agent_name: string | null
  agent_version: string | null
  prompt_hash: string | null
  model: string | null
  input_id: string | null
  payload: string
  parent_event: string | null
  batch_id: string | null
}

function rowToEvent(r: EventRow): Event {
  return {
    id: r.id,
    ts: r.ts,
    artifact_kind: r.artifact_kind,
    artifact_id: r.artifact_id,
    action: r.action,
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    payload: JSON.parse(r.payload) as unknown,
    parent_event: r.parent_event,
    batch_id: r.batch_id,
    ...(r.agent_name !== null ? { agent_name: r.agent_name } : {}),
    ...(r.agent_version !== null ? { agent_version: r.agent_version } : {}),
    ...(r.prompt_hash !== null ? { prompt_hash: r.prompt_hash } : {}),
    ...(r.model !== null ? { model: r.model } : {}),
    ...(r.input_id !== null ? { input_id: r.input_id } : {}),
  }
}

function openReadonly(seedPath: string): Database.Database | null {
  const dbPath = join(seedPath, '.compost', 'events.sqlite')
  if (!existsSync(dbPath)) return null
  return new Database(dbPath, { readonly: true, fileMustExist: true })
}

const EVENT_COLUMNS =
  'id, ts, artifact_kind, artifact_id, action, actor_type, actor_id, agent_name, agent_version, prompt_hash, model, input_id, payload, parent_event, batch_id'

/**
 * List the current snapshots of every artifact of `kind`, newest activity first.
 * Reads the append-only event log and folds each artifact's events with the
 * provenance reducer (no snapshot-table writes, so it's safe on a read-only DB).
 * Returns [] when the seed has no event log yet. Archived (rejected) artifacts
 * are excluded unless `includeArchived` is set.
 */
export function listArtifacts(
  seedPath: string,
  kind: string,
  opts: { includeArchived?: boolean } = {},
): SnapshotView[] {
  const db = openReadonly(seedPath)
  if (db === null) return []
  try {
    const rows = db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE artifact_kind = ? ORDER BY ts, rowid`)
      .all(kind) as EventRow[]

    const byArtifact = new Map<string, { events: Event[]; lastTs: string }>()
    for (const row of rows) {
      const bucket = byArtifact.get(row.artifact_id)
      if (bucket === undefined) {
        byArtifact.set(row.artifact_id, { events: [rowToEvent(row)], lastTs: row.ts })
      } else {
        bucket.events.push(rowToEvent(row))
        bucket.lastTs = row.ts // rows are ts-ordered, so the last seen is newest
      }
    }

    const views: SnapshotView[] = []
    for (const { events, lastTs } of byArtifact.values()) {
      const snapshot = reduce(events)
      if (snapshot === null) continue
      if (snapshot.archived && opts.includeArchived !== true) continue
      views.push({ ...snapshot, last_event_ts: lastTs })
    }
    // Newest activity first.
    views.sort((a, b) =>
      a.last_event_ts < b.last_event_ts ? 1 : a.last_event_ts > b.last_event_ts ? -1 : 0,
    )
    return views
  } finally {
    db.close()
  }
}

/**
 * Resolve a single artifact's current snapshot by ref — its human id
 * (`H-001`, `C-slug`, `T-slug`, stored in the create payload's `id`) or a
 * SHA256 artifact_id prefix. Returns null when the seed has no event log or no
 * matching artifact.
 */
export function getArtifact(seedPath: string, kind: string, ref: string): SnapshotView | null {
  const db = openReadonly(seedPath)
  if (db === null) return null
  try {
    let artifactId: string | undefined
    // Human id stored in the create event payload.
    const byHuman = db
      .prepare(
        "SELECT artifact_id FROM events WHERE artifact_kind = ? AND action = 'create' AND json_extract(payload, '$.id') = ? ORDER BY ts, rowid LIMIT 1",
      )
      .get(kind, ref) as { artifact_id: string } | undefined
    if (byHuman !== undefined) {
      artifactId = byHuman.artifact_id
    } else if (/^[a-f0-9]{8,64}$/i.test(ref)) {
      const bySha = db
        .prepare(
          "SELECT artifact_id FROM events WHERE artifact_kind = ? AND action = 'create' AND artifact_id LIKE ? ORDER BY ts, rowid LIMIT 1",
        )
        .get(kind, `${ref.toLowerCase()}%`) as { artifact_id: string } | undefined
      artifactId = bySha?.artifact_id
    }
    if (artifactId === undefined) return null

    const rows = db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE artifact_id = ? ORDER BY ts, rowid`)
      .all(artifactId) as EventRow[]
    if (rows.length === 0) return null
    const snapshot = reduce(rows.map(rowToEvent))
    if (snapshot === null) return null
    return { ...snapshot, last_event_ts: rows[rows.length - 1]?.ts ?? '' }
  } finally {
    db.close()
  }
}
