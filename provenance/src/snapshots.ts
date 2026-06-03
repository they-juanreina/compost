import type Database from 'better-sqlite3'

import { applyEvent, reduce, type Snapshot } from './reducer.js'
import type { Event } from './types.js'

const SELECT_SNAPSHOT_SQL = `
SELECT artifact_kind, artifact_id, current_state, version, last_event, human_approved, archived
FROM snapshots WHERE artifact_kind = ? AND artifact_id = ?
`

const UPSERT_SNAPSHOT_SQL = `
INSERT INTO snapshots (
  artifact_kind, artifact_id, current_state, version, last_event, human_approved, archived
) VALUES (@artifact_kind, @artifact_id, @current_state, @version, @last_event, @human_approved, @archived)
ON CONFLICT(artifact_kind, artifact_id) DO UPDATE SET
  current_state  = excluded.current_state,
  version        = excluded.version,
  last_event     = excluded.last_event,
  human_approved = excluded.human_approved,
  archived       = excluded.archived
`

const SELECT_EVENTS_FOR_ARTIFACT_SQL = `
SELECT * FROM events
WHERE artifact_kind = ? AND artifact_id = ?
ORDER BY ts, rowid
`

const SELECT_DISTINCT_ARTIFACTS_SQL = `
SELECT DISTINCT artifact_kind, artifact_id FROM events
`

const TRUNCATE_SNAPSHOTS_SQL = 'DELETE FROM snapshots'

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

interface SnapshotRow {
  artifact_kind: string
  artifact_id: string
  current_state: string
  version: number
  last_event: string
  human_approved: number
  archived: number
}

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    ts: row.ts,
    artifact_kind: row.artifact_kind,
    artifact_id: row.artifact_id,
    action: row.action as Event['action'],
    actor_type: row.actor_type as Event['actor_type'],
    actor_id: row.actor_id,
    ...(row.agent_name !== null ? { agent_name: row.agent_name } : {}),
    ...(row.agent_version !== null ? { agent_version: row.agent_version } : {}),
    ...(row.prompt_hash !== null ? { prompt_hash: row.prompt_hash } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    payload: JSON.parse(row.payload) as unknown,
    parent_event: row.parent_event,
    batch_id: row.batch_id,
  }
}

function rowToSnapshot(row: SnapshotRow): Snapshot {
  return {
    artifact_kind: row.artifact_kind,
    artifact_id: row.artifact_id,
    current_state: JSON.parse(row.current_state) as Record<string, unknown>,
    version: row.version,
    last_event: row.last_event,
    human_approved: row.human_approved === 1,
    archived: row.archived === 1,
  }
}

function snapshotToParams(s: Snapshot): Record<string, unknown> {
  return {
    artifact_kind: s.artifact_kind,
    artifact_id: s.artifact_id,
    current_state: JSON.stringify(s.current_state),
    version: s.version,
    last_event: s.last_event,
    human_approved: s.human_approved ? 1 : 0,
    archived: s.archived ? 1 : 0,
  }
}

export class SnapshotStore {
  private readonly select: Database.Statement
  private readonly upsert: Database.Statement
  private readonly selectEvents: Database.Statement
  private readonly selectArtifacts: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.select = db.prepare(SELECT_SNAPSHOT_SQL)
    this.upsert = db.prepare(UPSERT_SNAPSHOT_SQL)
    this.selectEvents = db.prepare(SELECT_EVENTS_FOR_ARTIFACT_SQL)
    this.selectArtifacts = db.prepare(SELECT_DISTINCT_ARTIFACTS_SQL)
  }

  /** Read the current snapshot from the snapshots table. */
  get(kind: string, id: string): Snapshot | null {
    const row = this.select.get(kind, id) as SnapshotRow | undefined
    return row === undefined ? null : rowToSnapshot(row)
  }

  /**
   * Full re-reduction for one artifact: read all its events, reduce, upsert.
   * O(n) in the number of events for the artifact.
   */
  refresh(kind: string, id: string): Snapshot | null {
    const rows = this.selectEvents.all(kind, id) as EventRow[]
    if (rows.length === 0) return null
    const events = rows.map(rowToEvent)
    const snapshot = reduce(events)
    if (snapshot === null) return null
    this.upsert.run(snapshotToParams(snapshot))
    return snapshot
  }

  /**
   * Incremental update: take an existing snapshot and apply one new event.
   * Cheaper than `refresh` when you already know the previous state.
   */
  apply(event: Event): Snapshot {
    const current = this.get(event.artifact_kind, event.artifact_id)
    const next = applyEvent(current, event)
    this.upsert.run(snapshotToParams(next))
    return next
  }

  /**
   * Rebuild every snapshot from scratch. Truncates and re-reduces each
   * artifact. Used by `compost reindex --snapshots`.
   */
  rebuildAll(): number {
    const artifacts = this.selectArtifacts.all() as Array<{
      artifact_kind: string
      artifact_id: string
    }>
    const tx = this.db.transaction(() => {
      this.db.prepare(TRUNCATE_SNAPSHOTS_SQL).run()
      for (const a of artifacts) this.refresh(a.artifact_kind, a.artifact_id)
    })
    tx()
    return artifacts.length
  }
}
