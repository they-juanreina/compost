import type { LLMAdapter } from '../llm/adapter.js'
import type { ProviderHealth } from '../llm/types.js'
import type { CompostConfig } from './config.js'
import { parseRoute } from './config.js'

export interface TaskReport {
  task: string
  route: string
  provider: string
  model: string
  status: 'ok' | 'provider_down' | 'model_missing' | 'unroutable'
  suggestion?: string
}

export interface DoctorReport {
  schema_version: '1.0'
  providers: Record<string, ProviderHealth>
  tasks: TaskReport[]
  /** Bidirectional reconcile (#175): models a provider has pulled but no
   * `[defaults]` route uses. Informational — not an error. Keyed by provider. */
  unused_models: Record<string, string[]>
  ok: boolean
}

/** A model is "present" if any reported model id starts with the routed model name. */
function modelPresent(health: ProviderHealth | undefined, model: string): boolean {
  if (health === undefined || !health.ok) return false
  return health.model_list.some(
    (m) => m === model || m.startsWith(`${model}:`) || m.startsWith(model),
  )
}

export async function runDoctor(adapter: LLMAdapter, config: CompostConfig): Promise<DoctorReport> {
  const providers = await adapter.healthAll()
  const tasks: TaskReport[] = []
  let ok = true

  // Configured model per provider, for the pulled-but-unused reconcile below.
  const configuredByProvider = new Map<string, Set<string>>()
  for (const route of Object.values(config.defaults)) {
    try {
      const { provider, model } = parseRoute(route)
      if (!configuredByProvider.has(provider)) configuredByProvider.set(provider, new Set())
      configuredByProvider.get(provider)?.add(model)
    } catch {
      // unroutable — handled per-task below
    }
  }

  for (const [task, route] of Object.entries(config.defaults)) {
    let provider = ''
    let model = ''
    try {
      const parsed = parseRoute(route)
      provider = parsed.provider
      model = parsed.model
    } catch {
      tasks.push({ task, route, provider: '', model: '', status: 'unroutable' })
      ok = false
      continue
    }

    const health = providers[provider]
    if (health === undefined || !health.ok) {
      tasks.push({ task, route, provider, model, status: 'provider_down' })
      ok = false
      continue
    }
    if (!modelPresent(health, model)) {
      const report: TaskReport = { task, route, provider, model, status: 'model_missing' }
      if (provider === 'ollama') report.suggestion = `ollama pull ${model}`
      tasks.push(report)
      ok = false
      continue
    }
    tasks.push({ task, route, provider, model, status: 'ok' })
  }

  // Reconcile the other direction: models a provider has pulled but nothing routes to.
  const unused_models: Record<string, string[]> = {}
  for (const [provider, health] of Object.entries(providers)) {
    if (!health.ok || health.model_list.length === 0) continue
    const configured = configuredByProvider.get(provider) ?? new Set<string>()
    const unused = health.model_list.filter(
      (m) => !configured.has(m) && ![...configured].some((c) => m === c || m.startsWith(`${c}:`)),
    )
    if (unused.length > 0) unused_models[provider] = unused
  }

  return { schema_version: '1.0', providers, tasks, unused_models, ok }
}
