import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Database from 'better-sqlite3'

import { ProvenanceError } from './errors.js'
import { applyMigrations } from './migrations/index.js'
import type { Event, EventInput } from './types.js'
import { generateUlid, type UlidOptions } from './ulid.js'
import { validateEvent } from './validate.js'

const INSERT_SQL = `
INSERT INTO events (
  id, ts, artifact_kind, artifact_id, action, actor_type, actor_id,
  agent_name, agent_version, prompt_hash, model, payload, parent_event, batch_id
) VALUES (
  @id, @ts, @artifact_kind, @artifact_id, @action, @actor_type, @actor_id,
  @agent_name, @agent_version, @prompt_hash, @model, @payload, @parent_event, @batch_id
)
ON CONFLICT(id) DO NOTHING
`

export interface EventWriterOptions {
  dbPath: string
  ulid?: UlidOptions
}

export class EventWriter {
  private readonly db: Database.Database
  private readonly insert: Database.Statement
  private readonly ulidOpts: UlidOptions

  constructor(opts: EventWriterOptions) {
    if (opts.dbPath.trim().length === 0) {
      throw new ProvenanceError('IO_ERROR', 'dbPath must not be empty')
    }
    if (opts.dbPath !== ':memory:') {
      mkdirSync(dirname(opts.dbPath), { recursive: true })
    }
    this.db = new Database(opts.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    applyMigrations(this.db)
    this.insert = this.db.prepare(INSERT_SQL)
    this.ulidOpts = opts.ulid ?? {}
  }

  appendEvent(input: EventInput): Event {
    const event = this.materialize(input)
    validateEvent(event)
    this.insertOne(event)
    return event
  }

  appendBatch(inputs: EventInput[], batchId: string): Event[] {
    if (batchId.trim().length === 0) {
      throw new ProvenanceError('IO_ERROR', 'batchId must not be empty for appendBatch')
    }
    const events = inputs.map((input) => this.materialize({ ...input, batch_id: batchId }))
    for (const e of events) validateEvent(e)
    const tx = this.db.transaction((items: Event[]) => {
      for (const e of items) this.insertOne(e)
    })
    tx(events)
    return events
  }

  close(): void {
    this.db.close()
  }

  private materialize(input: EventInput): Event {
    return {
      ...input,
      id: input.id ?? generateUlid(this.ulidOpts),
      ts: input.ts ?? new Date().toISOString(),
    }
  }

  private insertOne(event: Event): void {
    this.insert.run({
      id: event.id,
      ts: event.ts,
      artifact_kind: event.artifact_kind,
      artifact_id: event.artifact_id,
      action: event.action,
      actor_type: event.actor_type,
      actor_id: event.actor_id,
      agent_name: event.agent_name ?? null,
      agent_version: event.agent_version ?? null,
      prompt_hash: event.prompt_hash ?? null,
      model: event.model ?? null,
      payload: JSON.stringify(event.payload),
      parent_event: event.parent_event ?? null,
      batch_id: event.batch_id ?? null,
    })
  }
}
