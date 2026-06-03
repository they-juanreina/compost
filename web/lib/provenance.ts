// #36 — provenance badges + lineage modals + endorse/reject (pure).

export type ActorType = 'researcher' | 'agent' | 'ai'
export interface Event {
  id: string
  ts: string
  action: string
  actor_type: ActorType
  actor_id: string
  agent_name?: string | null
  agent_version?: string | null
  model?: string | null
  parent_event?: string | null
}

/** Badge label for an artifact's current state, from its latest event. */
export function badge(latest: Event, humanApproved: boolean): string {
  if (latest.actor_type === 'ai') return humanApproved ? '[ai] [endorsed]' : '[ai] [draft]'
  if (latest.actor_type === 'agent')
    return `[agent: ${latest.agent_name ?? '?'}@${latest.agent_version ?? '?'}]`
  return `[researcher: ${latest.actor_id}]${humanApproved ? ' [endorsed]' : ''}`
}

/** Order an event set into a lineage chain via parent_event (root first). */
export function lineageChain(events: Event[]): Event[] {
  const byId = new Map(events.map((e) => [e.id, e]))
  const children = new Map<string | null, Event[]>()
  for (const e of events) {
    const key = e.parent_event ?? null
    children.set(key, [...(children.get(key) ?? []), e])
  }
  const roots = (children.get(null) ?? []).sort((a, b) => a.ts.localeCompare(b.ts))
  const out: Event[] = []
  const walk = (e: Event) => {
    out.push(e)
    for (const c of (children.get(e.id) ?? []).sort((a, b) => a.ts.localeCompare(b.ts))) walk(c)
  }
  for (const r of roots) walk(r)
  // include any orphans (parent missing) so nothing is dropped
  for (const e of events) {
    const parent = e.parent_event
    if (!out.includes(e) && (parent == null || !byId.has(parent))) out.push(e)
  }
  return out
}

/** human_approved after applying an endorse/reject on top of the current state. */
export function applyDecision(_humanApproved: boolean, decision: 'endorse' | 'reject'): boolean {
  return decision === 'endorse'
}
