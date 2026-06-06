import { existsSync } from 'node:fs'

import Database from 'better-sqlite3'

import { CompostError } from '../errors.js'

/**
 * PROV-O (W3C) export of a seed's event log, as JSON-LD. Stub: covers the core
 * relations, not the full PROV-AGENT vocabulary.
 *
 *   artifact            → prov:Entity
 *   event/action        → prov:Activity (prov:generated / prov:used)
 *   actor               → prov:Agent (researcher=prov:Person; agent/ai=prov:SoftwareAgent,
 *                         ai also provagent:AIAgent)
 *   parent_event        → prov:wasInformedBy (+ artifact prov:wasDerivedFrom)
 *   input bundle        → prov:Entity prov:used by the generating Activity
 *
 * Because §1 persists inputs, an AI Activity lists its real prov:used input entity
 * instead of only an opaque prompt_hash — the point of the export.
 */

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
  model: string | null
  input_id: string | null
  parent_event: string | null
}

export interface ProvExport {
  document: Record<string, unknown>
  entities: number
  activities: number
  agents: number
  inputs: number
}

const CONTEXT = {
  prov: 'http://www.w3.org/ns/prov#',
  compost: 'https://compost.dev/prov#',
  provagent: 'https://compost.dev/prov-agent#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
}

const ART = (id: string) => `compost:artifact/${id}`
const EVT = (id: string) => `compost:event/${id}`
const AGENT = (id: string) => `compost:agent/${encodeURIComponent(id)}`
const INPUT = (id: string) => `compost:input/${id}`

function agentTypes(actorType: string): string[] {
  if (actorType === 'researcher') return ['prov:Agent', 'prov:Person']
  if (actorType === 'ai') return ['prov:Agent', 'prov:SoftwareAgent', 'provagent:AIAgent']
  return ['prov:Agent', 'prov:SoftwareAgent'] // agent
}

export function eventsToProvO(eventsDbPath: string): ProvExport {
  if (!existsSync(eventsDbPath)) {
    throw new CompostError('FILE_NOT_FOUND', `No events.sqlite at ${eventsDbPath}`)
  }
  const db = new Database(eventsDbPath, { readonly: true, fileMustExist: true })
  let rows: EventRow[]
  try {
    rows = db
      .prepare(
        'SELECT id, ts, artifact_kind, artifact_id, action, actor_type, actor_id, agent_name, agent_version, model, input_id, parent_event FROM events ORDER BY ts, rowid',
      )
      .all() as EventRow[]
  } finally {
    db.close()
  }

  const graph: Array<Record<string, unknown>> = []
  const artifacts = new Map<string, string>() // artifact_id → kind
  const agents = new Map<string, string>() // actor_id → actor_type
  const inputs = new Set<string>()

  for (const e of rows) {
    if (!artifacts.has(e.artifact_id)) artifacts.set(e.artifact_id, e.artifact_kind)
    if (!agents.has(e.actor_id)) agents.set(e.actor_id, e.actor_type)
    if (e.input_id !== null) inputs.add(e.input_id)

    const activity: Record<string, unknown> = {
      '@id': EVT(e.id),
      '@type': 'prov:Activity',
      'prov:startedAtTime': { '@value': e.ts, '@type': 'xsd:dateTime' },
      'prov:wasAssociatedWith': { '@id': AGENT(e.actor_id) },
      'compost:action': e.action,
      'compost:artifactKind': e.artifact_kind,
    }
    // create/link generate the entity; other actions use it.
    if (e.action === 'create' || e.action === 'link') {
      activity['prov:generated'] = { '@id': ART(e.artifact_id) }
    } else {
      activity['prov:used'] = { '@id': ART(e.artifact_id) }
    }
    if (e.input_id !== null) {
      const used = activity['prov:used']
      const inputRef = { '@id': INPUT(e.input_id) }
      activity['prov:used'] = used === undefined ? inputRef : [used, inputRef]
    }
    if (e.parent_event !== null) {
      activity['prov:wasInformedBy'] = { '@id': EVT(e.parent_event) }
    }
    if (e.model !== null) activity['compost:model'] = e.model
    graph.push(activity)
  }

  // Entities (artifacts), with derivation across their event chain.
  for (const [artifactId, kind] of artifacts) {
    graph.push({
      '@id': ART(artifactId),
      '@type': 'prov:Entity',
      'compost:kind': kind,
      'compost:contentAddress': artifactId,
    })
  }
  // Agents.
  for (const [actorId, actorType] of agents) {
    graph.push({
      '@id': AGENT(actorId),
      '@type': agentTypes(actorType),
      'compost:actorType': actorType,
      'compost:actorId': actorId,
    })
  }
  // Input bundles as entities (the reconstructable inputs §1 persists).
  for (const inputId of inputs) {
    graph.push({
      '@id': INPUT(inputId),
      '@type': 'prov:Entity',
      'compost:kind': 'ai_input_bundle',
      'compost:contentAddress': inputId,
    })
  }

  return {
    document: { '@context': CONTEXT, '@graph': graph },
    entities: artifacts.size,
    activities: rows.length,
    agents: agents.size,
    inputs: inputs.size,
  }
}
