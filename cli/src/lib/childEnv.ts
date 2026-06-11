import { KNOWN_SECRET_NAMES } from './secrets.js'

/**
 * Least-privilege env for spawned child processes (#236 readiness follow-up).
 *
 * Startup autoload copies `~/.compost/secrets.env` into `process.env` so the
 * parent resolves file-stored secrets everywhere. The side effect is that any
 * child spawned with the inherited environment would also receive every secret
 * — a `git commit`, a `docker info` probe, an `ollama pull`, or `pip install`
 * has no need for `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`HUGGINGFACE_TOKEN`.
 * Pass `scrubbedEnv()` (no secrets) or `childEnv({ NAME: value })` (a scrubbed
 * env plus exactly the secrets that child needs) instead of the raw inherit.
 */

/** Suffix shapes that mark an env var as secret-bearing, so a future provider
 * key (e.g. `MISTRAL_API_KEY`) is scrubbed without editing this list. */
const SECRET_SHAPE_RE =
  /(_TOKEN|_API_KEY|_SECRET_KEY|_ACCESS_KEY|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS?)$/i

const KNOWN = new Set<string>(KNOWN_SECRET_NAMES as readonly string[])

/** True when `name` looks like it holds a secret and should not be inherited
 * by a child that didn't explicitly ask for it. */
export function isSecretName(name: string): boolean {
  return KNOWN.has(name) || SECRET_SHAPE_RE.test(name)
}

/** A copy of `base` with secret-shaped names removed. Children still inherit
 * PATH/HOME/locale/etc. — just not the user's tokens. */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (!isSecretName(k)) out[k] = v
  }
  return out
}

/**
 * A scrubbed env with an explicit allow-list of secrets re-added. Use for a
 * child that needs exactly one secret (e.g. the transcriber needs only
 * `HUGGINGFACE_TOKEN`). Empty/undefined values are dropped.
 */
export function childEnv(
  allow: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out = scrubbedEnv(base)
  for (const [k, v] of Object.entries(allow)) {
    if (v !== undefined && v !== '') out[k] = v
  }
  return out
}
