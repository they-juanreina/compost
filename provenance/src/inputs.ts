import { createHash } from 'node:crypto'

/**
 * The reconstructable inputs to a generation (an AI suggestion or a deterministic
 * agent operation). Content-addressed by {@link inputId} and persisted in the
 * `ai_inputs` table (migration 0003) so `compost rerun` can regenerate the output
 * and a PROV-O export can express the Activity's real `prov:used` entities — where
 * today only a one-way `prompt_hash` survives.
 */
export interface AiInputBundle {
  /** Model identifier, e.g. `anthropic:claude-opus-4-8` or `ollama:bge-m3`. For a
   * deterministic agent, the operative model (e.g. the embedding model) or the
   * agent's `name@version`. */
  model: string
  /** Sampling / operation parameters, e.g. `{ temperature, top_p, max_tokens, seed }`
   * or, for a clustering agent, `{ threshold, minSize }`. */
  params?: Record<string, unknown> | null
  /** System prompt, when one was used. */
  system_prompt?: string | null
  /** The rendered user prompt / messages (JSON) for an LLM call, or a canonical
   * description of the operation for a deterministic agent. Required — it is the
   * minimum needed to re-derive the output. */
  prompt: string
  /** Injected context: retrieved evidence `[{ utterance_id, session_id, quote,
   * content_sha }]`, glossary terms, member ids, retrieval params. Any JSON. */
  context?: unknown
}

/** A persisted `ai_inputs` row (params/context parsed back from JSON). */
export interface AiInputRow {
  input_id: string
  model: string
  params: Record<string, unknown> | null
  system_prompt: string | null
  prompt: string
  context: unknown
  created_at: string
}

/**
 * Deterministic JSON serialization: object keys sorted recursively, arrays kept in
 * order, `undefined` dropped. Two structurally-equal bundles always serialize
 * identically, so {@link inputId} is stable regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v === undefined) continue
      out[key] = canonicalize(v)
    }
    return out
  }
  return value
}

/** Normalize optional fields to an explicit shape so presence/absence of optionals
 * never changes the hash. */
function normalize(bundle: AiInputBundle): Record<string, unknown> {
  return {
    model: bundle.model,
    params: bundle.params ?? null,
    system_prompt: bundle.system_prompt ?? null,
    prompt: bundle.prompt,
    context: bundle.context ?? null,
  }
}

/** Content-address an input bundle: sha256 of its canonical JSON. */
export function inputId(bundle: AiInputBundle): string {
  return createHash('sha256')
    .update(canonicalJson(normalize(bundle)))
    .digest('hex')
}
