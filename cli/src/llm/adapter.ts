import { CompostError } from '../errors.js'
import { type CompostConfig, parseRoute, providerApiKey, providerBaseUrl } from '../lib/config.js'
import { AnthropicProvider } from './providers/anthropic.js'
import { LMStudioProvider } from './providers/lmstudio.js'
import { OllamaProvider } from './providers/ollama.js'
import { OpenAIProvider } from './providers/openai.js'
import type {
  ChatMessage,
  ChatResponse,
  EmbedResponse,
  FetchLike,
  Provider,
  ProviderHealth,
} from './types.js'

export interface AdapterOptions {
  /** Inject a fetch stub for tests. Applied to every constructed provider. */
  fetchImpl?: FetchLike
}

export class LLMAdapter {
  private readonly providers = new Map<string, Provider>()

  constructor(
    private readonly config: CompostConfig,
    private readonly opts: AdapterOptions = {},
  ) {}

  /** Construct (and cache) the driver for a provider name. */
  getProvider(name: string): Provider {
    const cached = this.providers.get(name)
    if (cached) return cached

    const baseUrl = providerBaseUrl(this.config, name)
    const apiKey = providerApiKey(this.config, name)
    const cfg = {
      baseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
    }

    let provider: Provider
    switch (name) {
      case 'ollama':
        provider = new OllamaProvider(cfg)
        break
      case 'lmstudio':
        provider = new LMStudioProvider(cfg)
        break
      case 'openai':
        provider = new OpenAIProvider(cfg)
        break
      case 'anthropic':
        provider = new AnthropicProvider(cfg)
        break
      default:
        throw new CompostError('CONFIG_ERROR', `Unknown provider "${name}"`)
    }
    this.providers.set(name, provider)
    return provider
  }

  /** Resolve a task to its routed provider+model via the [defaults] table. */
  resolveTask(task: string): { provider: string; model: string } {
    const route = this.config.defaults[task]
    if (route === undefined) {
      throw new CompostError('CONFIG_ERROR', `No route configured for task "${task}" in [defaults]`)
    }
    return parseRoute(route)
  }

  async chat(
    task: string,
    messages: ChatMessage[],
    extra: { schema?: Record<string, unknown>; temperature?: number; maxTokens?: number } = {},
  ): Promise<ChatResponse> {
    const { provider, model } = this.resolveTask(task)
    this.assertProviderHasKey(task, provider)
    return this.getProvider(provider).chat({ model, messages, ...extra })
  }

  async embed(task: string, input: string[]): Promise<EmbedResponse> {
    const { provider, model } = this.resolveTask(task)
    this.assertProviderHasKey(task, provider)
    return this.getProvider(provider).embed({ model, input })
  }

  /** Fail fast with an actionable message when a task routes to a key-requiring
   * provider whose key isn't set — instead of a raw 401 from the HTTP layer. A
   * provider needs a key iff it declares `api_key_env` in [providers] (local
   * providers like ollama/lmstudio don't). */
  private assertProviderHasKey(task: string, provider: string): void {
    const envName = this.config.providers[provider]?.api_key_env
    if (envName === undefined) return // local provider — no key needed
    if (providerApiKey(this.config, provider) !== undefined) return // key present
    throw new CompostError(
      'CONFIG_ERROR',
      `The "${task}" task routes to ${provider}, which needs an API key — set ${envName}, ` +
        'or route to a local model (e.g. `compost chat --task quick_chat`).',
    )
  }

  /** Probe every distinct provider referenced by [defaults] plus those configured. */
  async healthAll(): Promise<Record<string, ProviderHealth>> {
    const names = new Set<string>(Object.keys(this.config.providers))
    for (const route of Object.values(this.config.defaults)) {
      try {
        names.add(parseRoute(route).provider)
      } catch {
        // skip malformed routes; doctor surfaces them separately
      }
    }
    const out: Record<string, ProviderHealth> = {}
    await Promise.all(
      [...names].map(async (name) => {
        try {
          out[name] = await this.getProvider(name).health()
        } catch (err) {
          out[name] = {
            ok: false,
            latency_ms: 0,
            model_list: [],
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    )
    return out
  }
}
