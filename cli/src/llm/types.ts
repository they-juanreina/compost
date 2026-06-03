export type Task =
  | 'embeddings'
  | 'quick_chat'
  | 'synthesis'
  | 'verification'
  | 'code-suggest'
  | 'theme-draft'
  | 'frame-annotation'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  /** JSON Schema for structured output. Providers that support JSON mode enforce it. */
  schema?: Record<string, unknown>
  temperature?: number
  maxTokens?: number
}

export interface ChatResponse {
  text: string
  model: string
  provider: string
  raw?: unknown
}

export interface EmbedRequest {
  model: string
  input: string[]
}

export interface EmbedResponse {
  vectors: number[][]
  model: string
  provider: string
}

export interface ProviderHealth {
  ok: boolean
  latency_ms: number
  model_list: string[]
  error?: string
}

/** A FetchLike lets tests inject a stub instead of the global fetch. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  statusText: string
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

export interface ProviderConfig {
  baseUrl: string
  apiKey?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

export interface Provider {
  readonly name: string
  chat(req: ChatRequest): Promise<ChatResponse>
  embed(req: EmbedRequest): Promise<EmbedResponse>
  health(): Promise<ProviderHealth>
}
