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

  return { schema_version: '1.0', providers, tasks, ok }
}
