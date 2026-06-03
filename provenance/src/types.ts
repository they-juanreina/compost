export type ActorType = 'researcher' | 'agent' | 'ai'

export type Action = 'create' | 'update' | 'endorse' | 'reject' | 'link' | 'unlink'

export interface EventBase {
  artifact_kind: string
  artifact_id: string
  action: Action
  actor_type: ActorType
  actor_id: string
  agent_name?: string
  agent_version?: string
  prompt_hash?: string
  model?: string
  payload: unknown
  parent_event?: string | null
  batch_id?: string | null
}

export interface Event extends EventBase {
  id: string
  ts: string
}

export type EventInput = EventBase & {
  id?: string
  ts?: string
}
