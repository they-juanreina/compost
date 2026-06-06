import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { type AiInputRow, EventWriter, inputId } from '@they-juanreina/compost-provenance'
import Database from 'better-sqlite3'

import { CompostError } from '../errors.js'
import { HUMAN_REF_RE } from './artifacts.js'

interface CreateRow {
  id: string
  artifact_kind: string
  artifact_id: string
  actor_type: string
  model: string | null
  input_id: string | null
  payload: string
}

/** Resolve an artifact ref (event ULID, human id, SHA prefix, or latest:<kind>) to
 * its `create` event row. For a non-create event id, falls back to the artifact's
 * create. Mirrors blame/endorse ref handling. */
function resolveCreateEvent(db: Database.Database, ref: string): CreateRow | undefined {
  const cols = 'id, artifact_kind, artifact_id, actor_type, model, input_id, payload'
  // Direct event ULID.
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ref)) {
    const row = db.prepare(`SELECT ${cols}, action FROM events WHERE id = ?`).get(ref) as
      | (CreateRow & { action: string })
      | undefined
    if (row === undefined) return undefined
    if (row.action === 'create') return row
    return db
      .prepare(
        `SELECT ${cols} FROM events WHERE artifact_id = ? AND action='create' ORDER BY ts, rowid LIMIT 1`,
      )
      .get(row.artifact_id) as CreateRow | undefined
  }
  // Human id (C-slug / H-NNN / T-slug) stored in create payload.id.
  if (HUMAN_REF_RE.test(ref)) {
    return db
      .prepare(
        `SELECT ${cols} FROM events WHERE action='create' AND json_extract(payload, '$.id') = ? ORDER BY ts, rowid LIMIT 1`,
      )
      .get(ref) as CreateRow | undefined
  }
  // latest:<kind>=<seed>
  const latest = /^latest:(\w+)=/.exec(ref)
  if (latest) {
    return db
      .prepare(
        `SELECT ${cols} FROM events WHERE artifact_kind = ? AND action='create' ORDER BY ts DESC, rowid DESC LIMIT 1`,
      )
      .get(latest[1] as string) as CreateRow | undefined
  }
  // SHA256 prefix.
  if (/^[a-f0-9]{8,64}$/i.test(ref)) {
    return db
      .prepare(
        `SELECT ${cols} FROM events WHERE artifact_id LIKE ? AND action='create' ORDER BY ts, rowid LIMIT 1`,
      )
      .get(`${ref.toLowerCase()}%`) as CreateRow | undefined
  }
  return undefined
}

export interface RerunReport {
  status: 'verified' | 'regenerated'
  artifact_id: string
  artifact_kind: string
  create_event_id: string
  actor_type: string
  model: string | null
  /** Did the stored bundle hash back to the event's input_id? */
  integrity_ok: boolean
  /** Regeneration (only with apply). */
  regenerated_event_id?: string
  applied_model?: string
  diff?: PayloadDiff
  note?: string
}

export interface PayloadDiff {
  changed: boolean
  fields: Array<{ field: string; before: unknown; after: unknown }>
}

/** Shallow field-level diff between two payload objects. */
export function diffPayload(before: unknown, after: unknown): PayloadDiff {
  const a = (before ?? {}) as Record<string, unknown>
  const b = (after ?? {}) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  const fields: PayloadDiff['fields'] = []
  for (const field of keys) {
    if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) {
      fields.push({ field, before: a[field], after: b[field] })
    }
  }
  return { changed: fields.length > 0, fields }
}

/** Regenerate an output from its captured inputs (model may be overridden).
 * Returns the new artifact payload. Injected so the LLM/provider dependency is
 * mockable; the CLI wires a default that calls the LLM adapter for `ai` bundles. */
export type Regenerator = (
  inputs: AiInputRow,
  ctx: { actorType: string; modelOverride?: string },
) => Promise<Record<string, unknown>>

export interface RerunOptions {
  ref: string
  apply?: boolean
  modelOverride?: string
  regenerate?: Regenerator
  researcherId?: string
}

/**
 * Rerun an AI/agent generation from its captured inputs.
 *
 * Default (no apply): VERIFY — confirm the stored bundle hashes back to the
 * event's input_id (the inputs are intact and reconstructable). With `apply`:
 * REGENERATE via the injected generator, emit a new event chained to the original
 * (parent_event), and diff the payloads. LLM regeneration is non-deterministic, so
 * an `ai` diff is fuzzy; a deterministic `agent` reproduces exactly.
 */
export async function rerunEvent(seedPath: string, opts: RerunOptions): Promise<RerunReport> {
  const eventsDb = join(seedPath, '.compost', 'events.sqlite')
  if (!existsSync(eventsDb)) {
    throw new CompostError('FILE_NOT_FOUND', 'No events.sqlite in seed; nothing to rerun.')
  }

  // Resolve target (read-only connection).
  const rdb = new Database(eventsDb, { readonly: true, fileMustExist: true })
  let target: CreateRow | undefined
  try {
    target = resolveCreateEvent(rdb, opts.ref)
  } finally {
    rdb.close()
  }
  if (target === undefined) {
    throw new CompostError('FILE_NOT_FOUND', `No create event found for ref "${opts.ref}".`)
  }
  if (target.input_id === null) {
    throw new CompostError(
      'INVALID_INPUT',
      `Event ${target.id} has no captured inputs (input_id is NULL — pre-migration, or a hash-only host create). It cannot be rerun; only events whose inputs were captured are reconstructable.`,
    )
  }

  // Load inputs + integrity-check via a writer connection (also used to append).
  const writer = new EventWriter({ dbPath: eventsDb })
  try {
    const inputs = writer.readInputs(target.input_id)
    if (inputs === undefined) {
      throw new CompostError(
        'INTERNAL',
        `input_id ${target.input_id} referenced by event ${target.id} is missing from ai_inputs.`,
      )
    }
    const integrity_ok =
      inputId({
        model: inputs.model,
        params: inputs.params,
        system_prompt: inputs.system_prompt,
        prompt: inputs.prompt,
        context: inputs.context,
      }) === target.input_id

    const base: RerunReport = {
      status: 'verified',
      artifact_id: target.artifact_id,
      artifact_kind: target.artifact_kind,
      create_event_id: target.id,
      actor_type: target.actor_type,
      model: target.model,
      integrity_ok,
    }

    if (opts.apply !== true) {
      return {
        ...base,
        note: 'Verify-only. Pass --apply to regenerate the output under the (optionally overridden) model and diff it.',
      }
    }

    if (opts.regenerate === undefined) {
      throw new CompostError(
        'CONFIG_ERROR',
        'Regeneration is not wired for this actor type yet. Inputs are intact and reconstructable; --apply regeneration currently requires an injected generator (LLM path needs a configured provider).',
      )
    }

    const newPayload = await opts.regenerate(inputs, {
      actorType: target.actor_type,
      ...(opts.modelOverride !== undefined ? { modelOverride: opts.modelOverride } : {}),
    })
    const appliedModel = opts.modelOverride ?? inputs.model

    // Emit the regenerated output, chained to the original create.
    const rerunInputId = writer.recordInputs({
      model: appliedModel,
      params: inputs.params,
      system_prompt: inputs.system_prompt,
      prompt: inputs.prompt,
      context: inputs.context,
    })
    const isAi = target.actor_type === 'ai'
    const rerun = writer.appendEvent({
      artifact_kind: target.artifact_kind,
      artifact_id: target.artifact_id,
      action: 'update',
      actor_type: isAi ? 'ai' : 'agent',
      actor_id: isAi ? appliedModel : `${target.model ?? 'agent'}`,
      ...(isAi ? { model: appliedModel, prompt_hash: rerunInputId } : {}),
      ...(!isAi ? { agent_name: 'rerun', agent_version: '0.1.0' } : {}),
      input_id: rerunInputId,
      parent_event: target.id,
      batch_id: `rerun:${target.id}`,
      payload: { rerun_of: target.id, ...newPayload },
    })

    return {
      ...base,
      status: 'regenerated',
      regenerated_event_id: rerun.id,
      applied_model: appliedModel,
      diff: diffPayload(safeParse(target.payload), newPayload),
    }
  } finally {
    writer.close()
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s)
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
