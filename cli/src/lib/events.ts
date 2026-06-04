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

/**
 * Author of a researcher- or AI-created artifact. A direct CLI invocation is a
 * researcher; the MCP wrapper (Claude Code) passes `ai` with an actor_id like
 * `claude-code:<plugin_ver>:<sha256(prompt)[:8]>` and a prompt_hash so the
 * suggestion lands as `[draft]` until a researcher endorses it.
 */
export interface Author {
  actorType: 'researcher' | 'ai'
  actorId: string
  model?: string
  promptHash?: string
}

/** Emit a researcher- or AI-authored `create` event. artifact_id is the SHA256
 * of initialState (the provenance content-address); the human-facing file id
 * lives in initialState.id so blame can map between them. */
export function emitCreate(
  writer: EventWriter,
  params: { artifactKind: string; initialState: Record<string, unknown>; author: Author },
): Event {
  const { author } = params
  const input: EventInput = {
    artifact_kind: params.artifactKind,
    artifact_id: artifactId(params.initialState),
    action: 'create',
    actor_type: author.actorType,
    actor_id: author.actorId,
    payload: params.initialState,
    ...(author.model !== undefined ? { model: author.model } : {}),
    ...(author.promptHash !== undefined ? { prompt_hash: author.promptHash } : {}),
  }
  return writer.appendEvent(input)
}

/** Emit a researcher `endorse` event chaining the artifact's create event.
 * Promotes an AI `[draft]` to endorsed (snapshot author becomes hybrid). */
export function emitEndorse(
  writer: EventWriter,
  params: {
    artifactKind: string
    artifactId: string
    parentEventId: string
    researcherId: string
  },
): Event {
  return writer.appendEvent({
    artifact_kind: params.artifactKind,
    artifact_id: params.artifactId,
    action: 'endorse',
    actor_type: 'researcher',
    actor_id: params.researcherId,
    parent_event: params.parentEventId,
    payload: { endorsed: true },
  })
}
