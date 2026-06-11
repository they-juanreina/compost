import { isSecretName } from './childEnv.js'

/**
 * Secret redaction backstop (#236 readiness follow-up).
 *
 * No call site is supposed to pass a token to a log field or an error message,
 * and none currently does. This is the structural guarantee under that
 * discipline: a single pass — used by the JSONL logger, `emitError`, and the
 * HTTP error-body helper — masks concrete secret values and common token shapes
 * so a future careless caller (or a hostile self-hosted provider echoing an
 * `Authorization` header into its JSON error body) cannot leak a live token.
 */

const MASK = '«redacted»'

/** Common token shapes, masked even when the value isn't a known env var. */
const SHAPE_PATTERNS: RegExp[] = [
  /\bhf_[A-Za-z0-9]{6,}\b/g, // HuggingFace user/access tokens
  /\bsk-[A-Za-z0-9_-]{6,}\b/g, // OpenAI / Anthropic style keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, // Authorization: Bearer <token>
]

/** Concrete values of secret-shaped env vars (e.g. the live HUGGINGFACE_TOKEN /
 * ANTHROPIC_API_KEY in this process), so the exact string is masked wherever it
 * appears. Skips trivially short values to avoid masking innocuous text. */
function envSecretValues(env: NodeJS.ProcessEnv): string[] {
  const vals: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && v.trim().length >= 6 && isSecretName(k)) vals.push(v)
  }
  return vals
}

/**
 * Mask secret material in free text bound for a log file or stderr. Masks both
 * the concrete values of secret-shaped env vars and common token shapes. Pure
 * (no I/O); cheap enough for the log/error path.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
  for (const val of envSecretValues(env)) {
    if (out.includes(val)) out = out.split(val).join(MASK) // literal, no regex escaping
  }
  for (const re of SHAPE_PATTERNS) out = out.replace(re, MASK)
  return out
}
