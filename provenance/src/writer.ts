import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Database from 'better-sqlite3'

import { ProvenanceError } from './errors.js'
import { type AiInputBundle, type AiInputRow, inputId } from './inputs.js'
import { applyMigrations } from './migrations/index.js'
import { SnapshotStore } from './snapshots.js'
import type { Event, EventInput } from './types.js'
import { generateUlid, type UlidOptions } from './ulid.js'
import { validateEvent } from './validate.js'

const INSERT_SQL = `
INSERT INTO events (
  id, ts, artifact_kind, artifact_id, action, actor_type, actor_id,
  agent_name, agent_version, prompt_hash, model, input_id, payload, parent_event, batch_id
) VALUES (
  @id, @ts, @artifact_kind, @artifact_id, @action, @actor_type, @actor_id,
  @agent_name, @agent_version, @prompt_hash, @model, @input_id, @payload, @parent_event, @batch_id
)
ON CONFLICT(id) DO NOTHING
`

const INSERT_INPUTS_SQL = `
INSERT INTO ai_inputs (input_id, model, params, system_prompt, prompt, context)
VALUES (@input_id, @model, @params, @system_prompt, @prompt, @context)
ON CONFLICT(input_id) DO NOTHING
`

export interface EventWriterOptions {
  dbPath: string
  ulid?: UlidOptions
}

export class EventWriter {
  private readonly db: Database.Database
  private readonly insert: Database.Statement
  private readonly insertInputs: Database.Statement
  private readonly selectInputs: Database.Statement
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
    this.insertInputs = this.db.prepare(INSERT_INPUTS_SQL)
    this.selectInputs = this.db.prepare('SELECT * FROM ai_inputs WHERE input_id = ?')
    this.ulidOpts = opts.ulid ?? {}
  }

  /**
   * Persist a generation's input bundle (content-addressed, dedup on input_id) and
   * return its input_id. Set that id as `input_id` on the event you then append so
   * the output is reconstructable (`compost rerun`) and expressible in PROV-O.
   */
  recordInputs(bundle: AiInputBundle): string {
    const id = inputId(bundle)
    this.insertInputs.run({
      input_id: id,
      model: bundle.model,
      params: bundle.params != null ? JSON.stringify(bundle.params) : null,
      system_prompt: bundle.system_prompt ?? null,
      prompt: bundle.prompt,
      context: bundle.context != null ? JSON.stringify(bundle.context) : null,
    })
    return id
  }

  /** Read back a persisted input bundle (params/context parsed from JSON). */
  readInputs(id: string): AiInputRow | undefined {
    const row = this.selectInputs.get(id) as
      | {
          input_id: string
          model: string
          params: string | null
          system_prompt: string | null
          prompt: string
          context: string | null
          created_at: string
        }
      | undefined
    if (row === undefined) return undefined
    return {
      input_id: row.input_id,
      model: row.model,
      params: row.params != null ? JSON.parse(row.params) : null,
      system_prompt: row.system_prompt,
      prompt: row.prompt,
      context: row.context != null ? JSON.parse(row.context) : null,
      created_at: row.created_at,
    }
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

  /** Construct a SnapshotStore that shares this writer's SQLite connection. */
  snapshots(): SnapshotStore {
    return new SnapshotStore(this.db)
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
      input_id: event.input_id ?? null,
      payload: JSON.stringify(event.payload),
      parent_event: event.parent_event ?? null,
      batch_id: event.batch_id ?? null,
    })
  }
}
