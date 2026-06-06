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
  /** Content-address (sha256) of the persisted input bundle in `ai_inputs` that
   * produced this event's output. Set on AI/agent generations whose inputs were
   * captured; absent for researcher events and for hash-only host-agent creates. */
  input_id?: string
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
