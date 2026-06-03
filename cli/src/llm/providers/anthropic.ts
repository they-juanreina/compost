import { getJsonTimed, postJson, resolveFetch } from '../http.js'
import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  FetchLike,
  Provider,
  ProviderConfig,
  ProviderHealth,
} from '../types.js'

const ANTHROPIC_VERSION = '2023-06-01'

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic'
  private readonly base: string
  private readonly apiKey: string | undefined
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(config: ProviderConfig) {
    this.base = config.baseUrl.replace(/\/$/, '')
    this.apiKey = config.apiKey
    this.fetchImpl = resolveFetch(config.fetchImpl)
    this.timeoutMs = config.timeoutMs ?? 120000
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.apiKey ?? '',
      'anthropic-version': ANTHROPIC_VERSION,
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Anthropic separates the system prompt from the messages array.
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }))

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages,
    }
    if (system.length > 0) body.system = system
    if (req.temperature !== undefined) body.temperature = req.temperature

    const json = (await postJson(
      this.fetchImpl,
      `${this.base}/v1/messages`,
      body,
      this.headers(),
      this.timeoutMs,
    )) as { content?: Array<{ type: string; text?: string }> }
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    return { text, model: req.model, provider: this.name, raw: json }
  }

  // Anthropic has no embeddings endpoint; route embeddings to Ollama/OpenAI instead.
  async embed(_req: EmbedRequest): Promise<EmbedResponse> {
    throw new Error(
      'anthropic provider does not support embeddings; route the embeddings task to ollama or openai',
    )
  }

  async health(): Promise<ProviderHealth> {
    try {
      const { json, latency_ms } = await getJsonTimed(
        this.fetchImpl,
        `${this.base}/v1/models`,
        this.headers(),
      )
      const data = (json as { data?: Array<{ id: string }> }).data ?? []
      return { ok: true, latency_ms, model_list: data.map((m) => m.id) }
    } catch (err) {
      return {
        ok: false,
        latency_ms: 0,
        model_list: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
