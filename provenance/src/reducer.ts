import type { Event } from './types.js'

export interface Snapshot {
  artifact_kind: string
  artifact_id: string
  current_state: Record<string, unknown>
  version: number
  last_event: string
  human_approved: boolean
  archived: boolean
}

/**
 * Apply a single event to an in-flight snapshot.
 *
 * Pure: no I/O, no clock. The event MUST belong to the same
 * (artifact_kind, artifact_id) as the snapshot.
 *
 * - `create`/`link` initializes (or re-initializes, if a prior `unlink` archived
 *   the relationship) the current_state from the event payload.
 * - `update` accepts either a full state object as payload, or a field-level
 *   patch `{ field, before, after }` where only `after` is applied.
 * - `endorse` flips human_approved to true and records the endorsing actor.
 * - `reject` archives the artifact; current_state is preserved for audit.
 * - `unlink` archives the relationship.
 */
export function applyEvent(snapshot: Snapshot | null, event: Event): Snapshot {
  if (snapshot !== null) {
    if (
      snapshot.artifact_kind !== event.artifact_kind ||
      snapshot.artifact_id !== event.artifact_id
    ) {
      throw new Error(
        `applyEvent: artifact mismatch — snapshot is ${snapshot.artifact_kind}/${snapshot.artifact_id}, event is ${event.artifact_kind}/${event.artifact_id}`,
      )
    }
  }

  const base: Snapshot = snapshot ?? {
    artifact_kind: event.artifact_kind,
    artifact_id: event.artifact_id,
    current_state: {},
    version: 0,
    last_event: '',
    human_approved: false,
    archived: false,
  }

  switch (event.action) {
    case 'create':
    case 'link':
      return {
        ...base,
        current_state: payloadAsObject(event.payload),
        human_approved: event.actor_type === 'researcher',
        archived: false,
        version: base.version + 1,
        last_event: event.id,
      }

    case 'update': {
      const next = mergeUpdate(base.current_state, event.payload)
      return { ...base, current_state: next, version: base.version + 1, last_event: event.id }
    }

    case 'endorse': {
      const endorsement = {
        endorsed_at: event.ts,
        endorsed_by: event.actor_id,
        ...(isObject(event.payload) ? event.payload : {}),
      }
      return {
        ...base,
        current_state: { ...base.current_state, _endorsement: endorsement },
        human_approved: true,
        version: base.version + 1,
        last_event: event.id,
      }
    }

    case 'reject':
    case 'unlink':
      return {
        ...base,
        current_state: {
          ...base.current_state,
          _archive_reason: isObject(event.payload)
            ? event.payload
            : { note: String(event.payload) },
          _archived_at: event.ts,
          _archived_by: event.actor_id,
        },
        human_approved: false,
        archived: true,
        version: base.version + 1,
        last_event: event.id,
      }

    default: {
      const _exhaustive: never = event.action
      throw new Error(`Unhandled action: ${_exhaustive}`)
    }
  }
}

/**
 * Reduce a chronologically-ordered event list for a single artifact down to
 * its current snapshot.
 *
 * Pure: same inputs → same output. Caller is responsible for sorting the
 * events by ts (or by ULID id, which is ts-prefixed) ascending.
 */
export function reduce(events: Event[]): Snapshot | null {
  if (events.length === 0) return null
  let snapshot: Snapshot | null = null
  for (const e of events) snapshot = applyEvent(snapshot, e)
  return snapshot
}

function payloadAsObject(payload: unknown): Record<string, unknown> {
  if (isObject(payload)) return { ...payload }
  if (payload === null || payload === undefined) return {}
  return { value: payload }
}

interface FieldPatch {
  field: string
  before?: unknown
  after: unknown
}

function isFieldPatch(value: unknown): value is FieldPatch {
  return (
    isObject(value) &&
    typeof (value as { field?: unknown }).field === 'string' &&
    'after' in (value as object)
  )
}

function mergeUpdate(current: Record<string, unknown>, payload: unknown): Record<string, unknown> {
  if (isFieldPatch(payload)) {
    return { ...current, [payload.field]: payload.after }
  }
  if (isObject(payload)) return { ...current, ...payload }
  return current
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
