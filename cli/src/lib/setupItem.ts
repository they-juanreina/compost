import { spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'

import { CompostError } from '../errors.js'
import { resolveFetch } from '../llm/http.js'
import type { FetchLike } from '../llm/types.js'
import {
  detectKeychain,
  fileIsSecure,
  HF_ALIASES,
  type RmResult,
  readSecretsFile,
  resolveSecret,
  rmSecret,
  type SetResult,
  setSecret,
} from './secrets.js'

/**
 * Per-item setup maintenance — the "fix one thing" surface.
 *
 * The read-only `compost setup` report (setup.ts) answers ONE question — is a
 * prerequisite PRESENT — cheaply, offline, and deterministically, because
 * agents and CI gate on its exact JSON. Its shape is frozen. This module is the
 * additive, on-demand layer the canonical report deliberately is not: it
 * addresses a single check by its stable id, knows the lifecycle ACTIONS
 * available on it (validate / renew / forget / pull / fix), and — for credential
 * checks — can probe whether the stored secret is actually LIVE, not merely set.
 *
 * The model is generic: `actionsFor(id)` + `runItem(id, action)` cover the HF
 * token (a credential), an Ollama model (a download), and a loose secret file
 * (a chmod) through the same two functions — it is not HF-specific. Nothing here
 * runs inside runSetup(); the live probe is never in the always-run path, so
 * PRESENCE (canonical, cheap) and VALIDITY (here, on demand) stay two explicit
 * signals rather than two answers that can contradict each other.
 */

/** A lifecycle action available on a setup item. `side` makes the two-sided
 * nature of a credential structural, not prose: 'local' is what compost owns
 * (keychain / 0600 file / Ollama store), 'remote' is the provider account only
 * the user controls, 'both' touches each in turn. */
export interface SetupItemAction {
  id: 'validate' | 'renew' | 'forget' | 'set' | 'pull' | 'fix'
  label: string
  side: 'local' | 'remote' | 'both'
  /** Where the user performs the remote half, when there is one. */
  url?: string
}

const HF_NAME = 'HUGGINGFACE_TOKEN'
const HF_TOKENS_URL = 'https://hf.co/settings/tokens'
const HF_WHOAMI_URL = 'https://huggingface.co/api/whoami-v2'
const MODEL_PREFIX = 'model:'
const PERMS_PREFIX = 'secret-perms:'

/** Lifecycle actions for a check id. Unknown ids return [] (no actions). The
 * registry is intentionally small: an action exists here only when a real
 * backing primitive does — it grows when a second real caller demands it. */
export function actionsFor(id: string): SetupItemAction[] {
  if (id === 'hf-token') {
    return [
      {
        id: 'validate',
        label: 'Check the stored token is live at HuggingFace',
        side: 'remote',
        url: HF_WHOAMI_URL,
      },
      {
        id: 'renew',
        label: 'Replace the stored token with a freshly minted one',
        side: 'both',
        url: HF_TOKENS_URL,
      },
      {
        id: 'forget',
        label: 'Forget the local copy (delete it at HuggingFace to truly revoke)',
        side: 'both',
        url: HF_TOKENS_URL,
      },
    ]
  }
  if (id.startsWith(MODEL_PREFIX)) {
    return [
      { id: 'pull', label: `Pull ${id.slice(MODEL_PREFIX.length)} via Ollama`, side: 'local' },
    ]
  }
  if (id.startsWith(PERMS_PREFIX)) {
    return [{ id: 'fix', label: 'Tighten the file permissions to 0600', side: 'local' }]
  }
  return []
}

export type ValidityStatus = 'ok' | 'fail' | 'warn'

export interface HfValidity {
  status: ValidityStatus
  detail: string
  account?: string
}

/**
 * Live HuggingFace token probe (mirrors version.ts's best-effort remote check).
 * 200 → ok + account; 401/403 → fail (revoked / expired / insufficient scope);
 * any network error → warn ('could not verify'), never throwing. This is the
 * trigger "renew" never had: a present-but-dead token reads as fail HERE,
 * instead of its 403 surfacing misattributed to the pyannote license check.
 */
export async function validateHfToken(
  token: string,
  deps: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<HfValidity> {
  const fetchImpl = resolveFetch(deps.fetchImpl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5000)
  try {
    const res = await fetchImpl(HF_WHOAMI_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (res.ok) {
      const who = (await res.json()) as { name?: string }
      return who.name
        ? { status: 'ok', detail: `valid (account: ${who.name})`, account: who.name }
        : { status: 'ok', detail: 'valid' }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        status: 'fail',
        detail: `rejected by HuggingFace (HTTP ${res.status}) — the token is revoked, expired, or lacks read scope`,
      }
    }
    return {
      status: 'warn',
      detail: `unexpected response from HuggingFace (HTTP ${res.status}) — could not verify`,
    }
  } catch {
    return { status: 'warn', detail: 'could not reach HuggingFace to verify (offline?)' }
  } finally {
    clearTimeout(timer)
  }
}

/** Where a secret's value currently lives, read from the RAW stores — not via
 * resolveSecret, whose 'env' source is polluted by the startup autoloader
 * (loadSecretsEnv copies the 0600 file into process.env, so a file-stored token
 * would otherwise masquerade as a shell export and be wrongly un-removable). */
export interface SecretSources {
  fileVal?: string
  kcVal?: string
  envVal?: string
}

export interface RunItemDeps {
  /** New secret value (for renew/set); the caller reads it from stdin/prompt. */
  value?: string
  fetchImpl?: FetchLike
  /** Injectable for tests; default to the real secrets primitives. */
  storeSecret?: typeof setSecret
  removeSecret?: typeof rmSecret
  resolve?: typeof resolveSecret
  /** Raw source breakdown for forget's safety logic; defaults to the real stores. */
  inspect?: (name: string) => SecretSources
  /** Streaming command runner for `pull` (ollama); defaults to spawnSync. */
  run?: (cmd: string, args: string[]) => { ok: boolean }
  /** Tighten a file to 0600 (`fix`); defaults to chmodSync. */
  chmod?: (path: string) => void
  /** Re-test a file's secrecy after `fix`; defaults to fileIsSecure. */
  isSecure?: (path: string) => boolean
}

/** Read the raw stores directly (keychain + 0600 file + process.env), so forget
 * can tell an autoloaded file value apart from a genuine shell export. */
function defaultInspect(name: string): SecretSources {
  const out: SecretSources = {}
  const envVal = process.env[name]
  if (envVal && envVal.trim() !== '') out.envVal = envVal
  const kcVal = detectKeychain()?.get(name)
  if (kcVal && kcVal.trim() !== '') out.kcVal = kcVal
  const file = readSecretsFile()
  if (file.exists && file.secure) {
    const fv = file.values[name]
    if (fv && fv.trim() !== '') out.fileVal = fv
  }
  return out
}

function defaultRun(cmd: string, args: string[]): { ok: boolean } {
  return { ok: spawnSync(cmd, args, { stdio: 'inherit' }).status === 0 }
}

export interface RunItemResult {
  id: string
  action: string
  /** Action-specific payload (SetResult, RmResult + remote_action, validity…). */
  result: unknown
  /** The item's status after the action, re-probed in isolation. */
  recheck: { status: ValidityStatus; detail: string }
}

function reject(id: string, action: string): never {
  const actions = actionsFor(id)
  if (actions.length === 0) {
    throw new CompostError(
      'INVALID_INPUT',
      `No maintainable item "${id}". Maintainable items: hf-token, model:<name>, secret-perms:<path>.`,
    )
  }
  throw new CompostError(
    'INVALID_INPUT',
    `Unknown action "${action}" for ${id}. Valid actions: ${actions.map((a) => a.id).join(', ')}.`,
  )
}

/**
 * Invoke one lifecycle action on one item, then re-probe just that item. The
 * single generic mutation primitive every caller (the CLI verb, the wizard's
 * per-item segment, the skill hand-off) routes through, so there is exactly one
 * implementation of each fix. Throws INVALID_INPUT for an unknown id or action.
 */
export async function runItem(
  id: string,
  action: string,
  deps: RunItemDeps = {},
): Promise<RunItemResult> {
  if (id === 'hf-token') return runHfToken(action, deps)
  if (id.startsWith(MODEL_PREFIX)) return runModelPull(id, action, deps)
  if (id.startsWith(PERMS_PREFIX)) return runPermsFix(id, action, deps)
  reject(id, action)
}

async function runHfToken(action: string, deps: RunItemDeps): Promise<RunItemResult> {
  const id = 'hf-token'
  const storeSecret = deps.storeSecret ?? setSecret
  const removeSecret = deps.removeSecret ?? rmSecret
  const resolve = deps.resolve ?? resolveSecret

  if (action === 'validate') {
    const found = resolve(HF_NAME, { aliases: HF_ALIASES })
    if (!found) {
      return {
        id,
        action,
        result: { present: false },
        recheck: { status: 'fail', detail: 'no token set (checked env, keychain, secrets.env)' },
      }
    }
    const v = await validateHfToken(found.value, deps)
    return {
      id,
      action,
      result: { source: found.source, ...v },
      recheck: { status: v.status, detail: v.detail },
    }
  }

  if (action === 'renew' || action === 'set') {
    const value = (deps.value ?? '').trim()
    if (value === '') {
      throw new CompostError('INVALID_INPUT', `No token value provided for ${id} ${action}.`)
    }
    const stored: SetResult = storeSecret(HF_NAME, value)
    const v = await validateHfToken(value, deps)
    return {
      id,
      action,
      result: {
        stored,
        validity: v,
        // The local store does not touch the OLD token at HuggingFace.
        remote_note: `The previous token stays valid at ${HF_TOKENS_URL} until you delete it there.`,
      },
      recheck: { status: v.status, detail: v.detail },
    }
  }

  // `forget` removes compost's local copy. `revoke` is accepted as a familiar
  // alias — but the action is named forget because compost cannot kill the token
  // server-side; only deleting it at HuggingFace does that.
  if (action === 'forget' || action === 'revoke') {
    const inspect = deps.inspect ?? defaultInspect
    const { fileVal, kcVal, envVal } = inspect(HF_NAME)
    const localPresent = fileVal !== undefined || kcVal !== undefined
    // A GENUINE shell export is an env value that isn't just our autoloaded
    // file/keychain value (loadSecretsEnv copies the 0600 file into env at
    // startup). Only that case is something compost cannot remove — env wins
    // over the stores, so a "forgotten" token still exported would keep working.
    const shellExport = envVal !== undefined && envVal !== fileVal && envVal !== kcVal
    const unsetNote = `${HF_NAME} is set in your shell environment, which compost cannot modify. Unset it yourself: \`unset ${HF_NAME}\` (and remove it from your shell profile).`

    if (!localPresent) {
      return {
        id,
        action: 'forget',
        result: shellExport
          ? {
              refused: true,
              source: 'env',
              detail: unsetNote,
              remote_action: {
                provider: 'huggingface',
                url: HF_TOKENS_URL,
                note: 'deleting the token at HuggingFace is the only thing that truly revokes it',
              },
            }
          : { removed_from: [], detail: 'nothing stored locally to forget' },
        recheck: shellExport
          ? { status: 'warn', detail: 'still set via shell env — not forgotten' }
          : { status: 'warn', detail: 'nothing stored locally to forget' },
      }
    }

    const removed: RmResult = removeSecret(HF_NAME)
    return {
      id,
      action: 'forget',
      result: {
        ...removed,
        ...(shellExport ? { still_in_env: true, env_note: unsetNote } : {}),
        remote_action: {
          provider: 'huggingface',
          url: HF_TOKENS_URL,
          note: 'local copy forgotten; the token is NOT dead until you delete it at HuggingFace',
        },
      },
      recheck: shellExport
        ? {
            status: 'warn',
            detail: `forgot local copy from ${removed.removed_from.join(' and ')}, but still set via shell env — unset it`,
          }
        : {
            status: 'ok',
            detail: `local copy forgotten from ${removed.removed_from.join(' and ')}`,
          },
    }
  }

  reject(id, action)
}

/** Generalization proof #1 — an Ollama model is just another item: its one
 * action is a local download, run through the same primitive as the HF token. */
async function runModelPull(id: string, action: string, deps: RunItemDeps): Promise<RunItemResult> {
  if (action !== 'pull') reject(id, action)
  const model = id.slice(MODEL_PREFIX.length)
  const run = deps.run ?? defaultRun
  const { ok } = run('ollama', ['pull', model])
  return {
    id,
    action,
    result: { ran: `ollama pull ${model}`, ok },
    recheck: ok
      ? { status: 'ok', detail: `pulled ${model}` }
      : { status: 'fail', detail: `pull failed — is Ollama running? retry: ollama pull ${model}` },
  }
}

/** Generalization proof #2 — a loose secret file is just another item: its one
 * action is a local chmod, with a deterministic re-stat as the recheck. */
async function runPermsFix(id: string, action: string, deps: RunItemDeps): Promise<RunItemResult> {
  if (action !== 'fix') reject(id, action)
  const path = id.slice(PERMS_PREFIX.length)
  const chmod = deps.chmod ?? ((p: string) => chmodSync(p, 0o600))
  const isSecure = deps.isSecure ?? fileIsSecure
  chmod(path)
  const secure = isSecure(path)
  return {
    id,
    action,
    result: { path, mode: '600', secure },
    recheck: secure
      ? { status: 'ok', detail: `${path} is now 0600` }
      : { status: 'warn', detail: `could not secure ${path} — check ownership` },
  }
}
