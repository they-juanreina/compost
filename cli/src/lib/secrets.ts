import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

import { CompostError, errMessage } from '../errors.js'

/**
 * Secret resolution + storage (#236 readiness hardening).
 *
 * Secrets (HuggingFace token, LLM provider API keys) are NEVER written into a
 * seed, `config.toml`, or the event ledger — `config.toml` stores only the
 * *name* of an env var (`api_key_env`). This module adds two secure conveniences
 * around the primary env-var mechanism, with a single documented precedence:
 *
 *   1. environment variable        (process.env[name]) — primary, always wins
 *   2. OS keychain                 (macOS `security` / Linux `secret-tool`)
 *   3. ~/.compost/secrets.env      (0600-enforced dotenv; refused if loose)
 *
 * The keychain tier shells out to the OS-native tool rather than pulling a
 * native npm dependency — keeping the supply chain tight (see SECURITY.md).
 * Where no keychain exists (Windows, headless Linux without libsecret) storage
 * falls back to the 0600 dotenv. The dotenv is auto-loaded into `process.env`
 * at CLI startup so file-stored secrets resolve everywhere the env var does,
 * without the user editing a shell profile.
 */

/** Keychain service name (macOS `-s` / Linux `service` attribute). */
export const KEYCHAIN_SERVICE = 'compost'

/** Where a secret was resolved from. */
export type SecretSource = 'env' | 'keychain' | 'file'

export interface ResolvedSecret {
  value: string
  source: SecretSource
}

/**
 * Names that `loadSecretsEnv` copied from the 0600 file into `process.env` this
 * run. Because the autoload makes a file-stored secret resolve via `process.env`
 * first, resolution would otherwise mislabel its source as `env`. Tracking the
 * autoloaded names lets `resolveSecret`/`listSecrets` report the truthful
 * `file` source (the value is the file's, not a shell export). Empty until
 * `loadSecretsEnv` runs (so direct unit tests are unaffected).
 */
const autoloadedNames = new Set<string>()

/**
 * Well-known secret names. Used by `compost secrets list` (which never reads
 * the value, only reports presence) and to decide what's worth probing in the
 * keychain. Not a hard allow-list — `set`/`get`/`rm` accept any valid env name.
 */
export const KNOWN_SECRET_NAMES = [
  'HUGGINGFACE_TOKEN',
  'HF_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const

/** Default aliases checked alongside a primary name when resolving. */
export const HF_ALIASES = ['HF_TOKEN']

/** A pluggable keychain backend. Real impls shell out; tests inject a fake. */
export interface KeychainBackend {
  /** Human label for messages, e.g. "macOS Keychain". */
  readonly label: string
  /** Return the stored secret, or undefined if absent / the tool errors. */
  get(name: string): string | undefined
  /** Store (or replace) the secret. Throws if the backend is unusable. */
  set(name: string, value: string): void
  /** Remove the secret. Returns true if something was removed. */
  del(name: string): boolean
}

export interface SecretsDeps {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /**
   * Explicit `~/.compost` root override (tests, or a custom location). Wins over
   * `$COMPOST_HOME` / `homedir()`.
   */
  home?: string
  /**
   * Keychain backend. Omitted → auto-detected from the platform. Pass `null` to
   * force "no keychain" (file-only) — used by tests and by `$COMPOST_NO_KEYCHAIN`.
   */
  keychain?: KeychainBackend | null
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Resolve the `~/.compost` root. `$COMPOST_HOME` overrides the default; an
 * explicit `deps.home` overrides everything (mirrors nativeRuntime.ts). */
export function compostHome(deps: SecretsDeps = {}): string {
  if (deps.home?.trim()) return deps.home
  const env = deps.env ?? process.env
  return env.COMPOST_HOME?.trim() ? (env.COMPOST_HOME as string) : join(homedir(), '.compost')
}

/** Path to the 0600 dotenv. `$COMPOST_SECRETS_ENV` points it at a custom file
 * (e.g. an existing per-user dotenv) without moving the rest of `~/.compost`. */
export function secretsEnvPath(deps: SecretsDeps = {}): string {
  const env = deps.env ?? process.env
  if (env.COMPOST_SECRETS_ENV?.trim()) return env.COMPOST_SECRETS_ENV as string
  return join(compostHome(deps), 'secrets.env')
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface PermIssue {
  path: string
  kind: 'file' | 'dir'
  /** Octal perms as observed, e.g. "644". */
  mode: string
  /** Copy-pasteable fix. */
  fix: string
  detail: string
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

/** POSIX-only secrecy test: a secret file must have no group/other bits. On
 * Windows (ACL model) mode bits aren't meaningful, so we treat it as secure. */
export function fileIsSecure(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return true
  try {
    return (statSync(path).mode & 0o077) === 0
  } catch {
    return true // absent file can't leak
  }
}

// ---------------------------------------------------------------------------
// Dotenv parsing
// ---------------------------------------------------------------------------

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Validate an env-var-shaped secret name; throws INVALID_INPUT otherwise. */
export function assertSecretName(name: string): void {
  if (!ENV_NAME_RE.test(name)) {
    throw new CompostError(
      'INVALID_INPUT',
      `Invalid secret name "${name}". Use an environment-variable name (letters, digits, underscore; not starting with a digit), e.g. HUGGINGFACE_TOKEN.`,
    )
  }
}

/** Minimal dotenv parser (no dependency). Supports `KEY=value`, `export KEY=`,
 * `#` comments, blank lines, and single/double-quoted values. Malformed lines
 * are skipped rather than throwing — a secrets file should never hard-fail a
 * CLI invocation. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '')
    if (!ENV_NAME_RE.test(key)) continue
    let val = line.slice(eq + 1).trim()
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

function serializeDotenv(values: Record<string, string>): string {
  const header =
    '# compost secrets — managed by `compost secrets`. Mode 0600; never commit.\n' +
    '# Each line is ENV_NAME=value. Environment variables of the same name win\n' +
    '# over this file; this file wins over nothing below it.\n'
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  return body ? `${header}${body}\n` : header
}

export interface SecretsFileRead {
  path: string
  exists: boolean
  /** False when the file is group/world-accessible — we then refuse to read it. */
  secure: boolean
  /** Parsed values; empty `{}` when the file is missing or refused. */
  values: Record<string, string>
}

/** Read the 0600 dotenv, refusing (without reading contents) when its perms are
 * loose — so an insecure file can never leak its secrets through compost. */
export function readSecretsFile(deps: SecretsDeps = {}): SecretsFileRead {
  const platform = deps.platform ?? process.platform
  const path = secretsEnvPath(deps)
  if (!existsSync(path)) return { path, exists: false, secure: true, values: {} }
  if (!fileIsSecure(path, platform)) {
    return { path, exists: true, secure: false, values: {} }
  }
  try {
    return { path, exists: true, secure: true, values: parseDotenv(readFileSync(path, 'utf8')) }
  } catch (cause) {
    throw new CompostError('IO_ERROR', `Could not read ${path}`, { cause })
  }
}

/** Ensure `~/.compost` exists at 0700 and return it. */
function ensureSecureHome(deps: SecretsDeps): string {
  const dir = compostHome(deps)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if ((deps.platform ?? process.platform) !== 'win32') {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // best-effort: a pre-existing dir we don't own; the perms check will warn.
    }
  }
  return dir
}

/** Write/replace a single key in the dotenv, always (re)normalizing perms to
 * 0600. Reads existing contents raw (bypassing the secrecy gate) so a key set
 * on a previously-loose file both preserves siblings and *fixes* the perms. */
function writeSecretToFile(name: string, value: string, deps: SecretsDeps): string {
  ensureSecureHome(deps)
  const path = secretsEnvPath(deps)
  const existing = existsSync(path) ? parseDotenv(readFileSync(path, 'utf8')) : {}
  existing[name] = value
  writeFileSync(path, serializeDotenv(existing), { mode: 0o600 })
  if ((deps.platform ?? process.platform) !== 'win32') chmodSync(path, 0o600)
  return path
}

/** Remove a key from the dotenv. Returns true if the key was present. */
function removeSecretFromFile(name: string, deps: SecretsDeps): boolean {
  const path = secretsEnvPath(deps)
  if (!existsSync(path)) return false
  const existing = parseDotenv(readFileSync(path, 'utf8'))
  if (!(name in existing)) return false
  delete existing[name]
  if (Object.keys(existing).length === 0) {
    rmSync(path, { force: true })
  } else {
    writeFileSync(path, serializeDotenv(existing), { mode: 0o600 })
    if ((deps.platform ?? process.platform) !== 'win32') chmodSync(path, 0o600)
  }
  return true
}

// ---------------------------------------------------------------------------
// Keychain backends (shell out — zero native deps)
// ---------------------------------------------------------------------------

interface CmdResult {
  ok: boolean
  stdout: string
  /** Exit status, or null when the binary couldn't be spawned (ENOENT). */
  code: number | null
}

function runCmd(cmd: string, args: string[], input?: string): CmdResult {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 8000,
      ...(input !== undefined ? { input } : {}),
    })
    return { ok: true, stdout, code: 0 }
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string | Buffer }
    const out = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? '')
    return { ok: false, stdout: out, code: typeof e.status === 'number' ? e.status : null }
  }
}

/** macOS Keychain via the `security` CLI. NB: `add-generic-password -w <value>`
 * passes the secret as an argv element, briefly visible to `ps` for the lifetime
 * of the spawned `security` process. The interactive `-w` (no value) prompt form
 * reads the password from the controlling TTY, not stdin, so it can't be fed via
 * our piped `runCmd` without allocating a pty — not worth it under the single-user
 * threat model. The exposure is documented in SECURITY.md ("Storing your tokens"). */
function macKeychain(): KeychainBackend {
  return {
    label: `macOS Keychain (service "${KEYCHAIN_SERVICE}")`,
    get(name) {
      const r = runCmd('security', [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        name,
        '-w',
      ])
      if (!r.ok) return undefined
      const v = r.stdout.replace(/\n$/, '')
      return v === '' ? undefined : v
    },
    set(name, value) {
      const r = runCmd('security', [
        'add-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        name,
        '-l',
        `${KEYCHAIN_SERVICE}: ${name}`,
        '-U', // update if present
        '-w',
        value,
      ])
      if (!r.ok) {
        throw new CompostError(
          'IO_ERROR',
          `macOS keychain write failed (security exit ${r.code ?? 'spawn-error'})`,
        )
      }
    },
    del(name) {
      const r = runCmd('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name])
      return r.ok
    },
  }
}

/** Linux Secret Service via libsecret's `secret-tool`. The secret is read from
 * stdin on store (never an argv). Requires a running Secret Service. */
function linuxKeychain(): KeychainBackend {
  const attrs = (name: string) => ['service', KEYCHAIN_SERVICE, 'key', name]
  return {
    label: `Secret Service (libsecret, service "${KEYCHAIN_SERVICE}")`,
    get(name) {
      const r = runCmd('secret-tool', ['lookup', ...attrs(name)])
      if (!r.ok) return undefined
      const v = r.stdout.replace(/\n$/, '')
      return v === '' ? undefined : v
    },
    set(name, value) {
      const r = runCmd(
        'secret-tool',
        ['store', '--label', `${KEYCHAIN_SERVICE}: ${name}`, ...attrs(name)],
        value,
      )
      if (!r.ok) {
        throw new CompostError(
          'IO_ERROR',
          `secret-tool store failed (exit ${r.code ?? 'spawn-error'}); is a Secret Service running?`,
        )
      }
    },
    del(name) {
      const r = runCmd('secret-tool', ['clear', ...attrs(name)])
      return r.ok
    },
  }
}

/** True when `secret-tool` is on PATH (any exit code means it spawned). */
function secretToolPresent(): boolean {
  return runCmd('secret-tool', []).code !== null
}

/** Auto-detect the platform keychain, or null when none is usable. */
export function detectKeychain(deps: SecretsDeps = {}): KeychainBackend | null {
  if (deps.keychain !== undefined) return deps.keychain
  const env = deps.env ?? process.env
  if (env.COMPOST_NO_KEYCHAIN?.trim()) return null
  const platform = deps.platform ?? process.platform
  if (platform === 'darwin') return macKeychain()
  if (platform === 'linux') return secretToolPresent() ? linuxKeychain() : null
  return null // win32 / other → dotenv fallback
}

// ---------------------------------------------------------------------------
// Resolve / set / get / rm / list
// ---------------------------------------------------------------------------

export interface ResolveOpts extends SecretsDeps {
  /** Extra names to try (e.g. HF_TOKEN alongside HUGGINGFACE_TOKEN). */
  aliases?: string[]
}

/** Resolve a secret by the documented precedence: env > keychain > 0600 file.
 * Returns undefined when set nowhere (or only in an insecure, refused file). */
export function resolveSecret(name: string, opts: ResolveOpts = {}): ResolvedSecret | undefined {
  const env = opts.env ?? process.env
  const names = [name, ...(opts.aliases ?? [])]

  for (const key of names) {
    const v = env[key]
    if (v && v.trim() !== '') {
      // If the autoload put this here, its real home is the 0600 file — report
      // that, not 'env', so the user isn't told a managed file is a shell export.
      return { value: v, source: autoloadedNames.has(key) ? 'file' : 'env' }
    }
  }

  const kc = detectKeychain(opts)
  if (kc) {
    for (const key of names) {
      const v = kc.get(key)
      if (v && v.trim() !== '') return { value: v, source: 'keychain' }
    }
  }

  const file = readSecretsFile(opts)
  if (file.exists && file.secure) {
    for (const key of names) {
      const v = file.values[key]
      if (v && v.trim() !== '') return { value: v, source: 'file' }
    }
  }
  return undefined
}

export interface SetResult {
  name: string
  stored_in: 'keychain' | 'file'
  /** Keychain label, or the dotenv path. */
  location: string
  /** Set when a keychain write was attempted but failed and we fell back. */
  fallback_reason?: string
}

/** Store a secret. Prefers the keychain; falls back to the 0600 dotenv when no
 * keychain exists or a keychain write fails. */
export function setSecret(name: string, value: string, deps: SecretsDeps = {}): SetResult {
  assertSecretName(name)
  if (value.trim() === '') {
    throw new CompostError('INVALID_INPUT', `Refusing to store an empty value for ${name}.`)
  }
  const kc = detectKeychain(deps)
  if (kc) {
    try {
      kc.set(name, value)
      return { name, stored_in: 'keychain', location: kc.label }
    } catch (err) {
      const reason = errMessage(err)
      const path = writeSecretToFile(name, value, deps)
      return { name, stored_in: 'file', location: path, fallback_reason: reason }
    }
  }
  const path = writeSecretToFile(name, value, deps)
  return { name, stored_in: 'file', location: path }
}

export interface RmResult {
  name: string
  removed_from: SecretSource[]
}

/** Remove a secret from the keychain and the dotenv (env vars are the user's
 * shell — we can't and don't touch those). */
export function rmSecret(name: string, deps: SecretsDeps = {}): RmResult {
  assertSecretName(name)
  const removed: SecretSource[] = []
  const kc = detectKeychain(deps)
  if (kc?.del(name)) removed.push('keychain')
  if (removeSecretFromFile(name, deps)) removed.push('file')
  return { name, removed_from: removed }
}

export interface SecretListing {
  name: string
  /** Sources that currently hold this secret (never the value itself). */
  sources: SecretSource[]
}

/** List which secrets are set and where — never the values. Covers the
 * well-known names plus anything found in the dotenv. */
export function listSecrets(deps: SecretsDeps = {}): {
  items: SecretListing[]
  file: SecretsFileRead
} {
  const env = deps.env ?? process.env
  const kc = detectKeychain(deps)
  const file = readSecretsFile(deps)
  const candidates = new Set<string>([...KNOWN_SECRET_NAMES, ...Object.keys(file.values)])

  const items: SecretListing[] = []
  for (const name of candidates) {
    const sources: SecretSource[] = []
    const e = env[name]
    // An autoloaded name is in env only because of the file — count it once, as
    // 'file' (below), not 'env', so it doesn't masquerade/double-count.
    if (e && e.trim() !== '' && !autoloadedNames.has(name)) sources.push('env')
    if (kc) {
      const v = kc.get(name)
      if (v && v.trim() !== '') sources.push('keychain')
    }
    if (file.secure && file.values[name]) sources.push('file')
    if (sources.length > 0) items.push({ name, sources })
  }
  items.sort((a, b) => a.name.localeCompare(b.name))
  return { items, file }
}

// ---------------------------------------------------------------------------
// Startup autoload
// ---------------------------------------------------------------------------

export interface AutoloadResult {
  path: string
  /** Names copied into the env (only those not already set). */
  loaded: string[]
  /** Why nothing loaded, when applicable. */
  skipped: 'not-found' | 'insecure-perms' | null
}

/** Load `~/.compost/secrets.env` into the environment at startup so file-stored
 * secrets resolve everywhere an env var would — without editing a shell profile.
 * Environment variables already set WIN (never overridden). An insecure file is
 * refused (not read) with a warning, preserving the "0600 or it doesn't load"
 * guarantee. Mutates `deps.env` (defaults to `process.env`). */
export function loadSecretsEnv(
  deps: SecretsDeps & { warn?: (msg: string) => void } = {},
): AutoloadResult {
  const env = deps.env ?? process.env
  const read = readSecretsFile(deps)
  if (!read.exists) return { path: read.path, loaded: [], skipped: 'not-found' }
  if (!read.secure) {
    deps.warn?.(
      `compost: refusing to load ${read.path} — it is group/world-readable. Fix with: chmod 600 ${read.path}`,
    )
    return { path: read.path, loaded: [], skipped: 'insecure-perms' }
  }
  const loaded: string[] = []
  for (const [k, v] of Object.entries(read.values)) {
    const cur = env[k]
    if (cur === undefined || cur === '') {
      env[k] = v
      loaded.push(k)
      // Remember the file is the true source, so resolution doesn't mislabel it 'env'.
      autoloadedNames.add(k)
    }
  }
  return { path: read.path, loaded, skipped: null }
}

// ---------------------------------------------------------------------------
// Permission audit (for `compost setup`)
// ---------------------------------------------------------------------------

const SCAN_SKIP_DIRS = new Set(['transcriber-venv', 'node_modules', '.git', '__pycache__'])
const SECRETISH_RE = /(secret|token|credential|api[_-]?key|\.env\b|\.key\b)/i
const SCAN_MAX_ENTRIES = 2000

/** Audit secret-storage permissions under `~/.compost`. Returns issues for:
 *   - the home dir if group/world-WRITABLE (someone could swap your secrets),
 *   - the managed `secrets.env` if group/world-accessible,
 *   - any secret-ish file (by path: token/secret/credential/.env/.key) that's
 *     group/world-readable — catches hand-rolled files like the world-readable
 *     `~/.compost/hf_token/compost.txt` a readiness test produced.
 * POSIX-only; Windows uses ACLs, so it returns []. */
export function auditSecretsPerms(deps: SecretsDeps = {}): PermIssue[] {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') return []
  const issues: PermIssue[] = []
  const home = compostHome(deps)

  // Home dir: flag group/world-writable (the dangerous case for a secrets dir).
  if (existsSync(home)) {
    try {
      const m = statSync(home).mode
      if ((m & 0o022) !== 0) {
        issues.push({
          path: home,
          kind: 'dir',
          mode: octal(m),
          fix: `chmod 700 ${home}`,
          detail: 'group/world-writable — others could replace files here',
        })
      }
    } catch {
      // unreadable dir: nothing we can assert
    }
  }

  // The managed dotenv specifically.
  const sp = secretsEnvPath(deps)
  if (existsSync(sp)) {
    try {
      const m = statSync(sp).mode
      if ((m & 0o077) !== 0) {
        issues.push({
          path: sp,
          kind: 'file',
          mode: octal(m),
          fix: `chmod 600 ${sp}`,
          detail: 'secrets file is group/world-readable',
        })
      }
    } catch {
      // ignore
    }
  }

  // Bounded scan for other secret-ish files left around the home dir.
  const seen = new Set(issues.map((i) => i.path))
  let budget = SCAN_MAX_ENTRIES
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || budget <= 0) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (--budget <= 0) return
      if (ent.isSymbolicLink()) continue // never follow links (cf. #212)
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(ent.name)) walk(full, depth + 1)
        continue
      }
      if (!ent.isFile()) continue
      const rel = relative(home, full)
      if (!SECRETISH_RE.test(rel)) continue
      if (seen.has(full)) continue
      try {
        const m = statSync(full).mode
        if ((m & 0o077) !== 0) {
          seen.add(full)
          issues.push({
            path: full,
            kind: 'file',
            mode: octal(m),
            fix: `chmod 600 ${full}`,
            detail: 'looks like a secret file and is group/world-readable',
          })
        }
      } catch {
        // ignore unreadable entry
      }
    }
  }
  if (existsSync(home)) walk(home, 0)

  return issues
}
