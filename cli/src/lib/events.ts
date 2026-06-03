import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { type Event, type EventInput, EventWriter } from 'compost-provenance'

/** Open an EventWriter on a seed's .compost/events.sqlite. */
export function openSeedEvents(seedPath: string): EventWriter {
  return new EventWriter({ dbPath: join(seedPath, '.compost', 'events.sqlite') })
}

/** Content-address an artifact's initial state (SHA256 of canonical JSON). */
export function artifactId(initialState: unknown): string {
  return createHash('sha256').update(JSON.stringify(initialState)).digest('hex')
}

/** Emit an agent-authored `create` event (used by ingest + ingest-watcher). */
export function emitAgentCreate(
  writer: EventWriter,
  params: {
    artifactKind: string
    initialState: Record<string, unknown>
    agentName: string
    agentVersion: string
    batchId?: string
  },
): Event {
  const input: EventInput = {
    artifact_kind: params.artifactKind,
    artifact_id: artifactId(params.initialState),
    action: 'create',
    actor_type: 'agent',
    actor_id: `${params.agentName}@${params.agentVersion}`,
    agent_name: params.agentName,
    agent_version: params.agentVersion,
    payload: params.initialState,
    ...(params.batchId !== undefined ? { batch_id: params.batchId } : {}),
  }
  return writer.appendEvent(input)
}
