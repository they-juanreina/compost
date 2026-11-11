import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CompostError } from '../errors.js'
import { getConfigValue, parseConfig } from './config.js'
import { loadUserConfigRaw, userConfigPath } from './userConfig.js'

/**
 * Git-style researcher identity (ADR 0008 decision 2). The ONE place every
 * surface (CLI, MCP via the CLI, web) resolves who a researcher-authored write
 * belongs to. Resolution order, first hit wins:
 *
 *   1. an explicit `--researcher` / `--actor-id` / `--coder` flag
 *   2. `$COMPOST_USER`
 *   3. the seed's `.compost/config.toml` `user.email`
 *   4. the global (per-user) `~/.compost/config.toml` `user.email`
 *   5. `git config user.email` — only if git is installed; never throws
 *
 * Nothing resolves → researcher writes refuse with `IDENTITY_UNSET` and the exact
 * command to fix it (git's "tell me who you are"). There is deliberately no
 * `$USER` or literal `researcher` fallback: two coders must never collapse into
 * one indistinguishable id (which would also defeat the self-endorse refusal).
 *
 * The identity is the email; `user.name` is a display label only, resolved
 * independently through the same chain (seed → global → git). Identity is
 * self-declared — signed endorsements are a separate, later layer. Agent / AI
 * actors carry their own ids and never come through here.
 */
export type IdentitySource = 'flag' | 'env' | 'seed_config' | 'global_config' | 'git'

export interface ResearcherIdentity {
  /** The actor id stamped on researcher events (an email by convention). */
  id: string
  /** Display label (`user.name`), or null when none is configured. */
  name: string | null
  source: IdentitySource
  /** Where it came from: the env var, config file path, or `git config`. */
  source_detail: string
}

export interface IdentityOptions {
  /** An explicit flag value (wins over everything). */
  explicit?: string | undefined
  /** The seed whose `.compost/config.toml` may carry a per-seed `user.email`. */
  seedPath?: string | undefined
  env?: NodeJS.ProcessEnv
  /** Reads one `git config` key; undefined when git or the key is absent.
   * Injectable for tests (the default shells out to git). */
  gitConfig?: (key: 'user.email' | 'user.name', cwd: string | undefined) => string | undefined
}

/** The command that fixes an unset identity, verbatim in the error message. */
export const SET_IDENTITY_COMMAND = 'compost config set user.email you@example.com --global'

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/** `git config --get <key>`, run where the seed lives (so a repo-local identity
 * applies, as in git). Any failure — git missing, key unset, timeout — is
 * undefined: identity lookup must never throw because git isn't installed. */
export function readGitConfig(key: string, cwd: string | undefined): string | undefined {
  try {
    const out = execFileSync('git', ['config', '--get', key], {
      cwd: cwd !== undefined && existsSync(cwd) ? cwd : undefined,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
    return nonEmpty(out)
  } catch {
    return undefined
  }
}

function seedUser(seedPath: string | undefined): { email?: string; name?: string; path: string } {
  if (seedPath === undefined) return { path: '' }
  const path = join(seedPath, '.compost', 'config.toml')
  if (!existsSync(path)) return { path }
  const raw = parseConfig(readFileSync(path, 'utf8')).raw
  const email = nonEmpty(getConfigValue(raw, 'user.email'))
  const name = nonEmpty(getConfigValue(raw, 'user.name'))
  return { ...(email ? { email } : {}), ...(name ? { name } : {}), path }
}

function globalUser(env: NodeJS.ProcessEnv): { email?: string; name?: string; path: string } {
  const path = userConfigPath(env)
  const raw = loadUserConfigRaw(env)
  const email = nonEmpty(getConfigValue(raw, 'user.email'))
  const name = nonEmpty(getConfigValue(raw, 'user.name'))
  return { ...(email ? { email } : {}), ...(name ? { name } : {}), path }
}

/** Resolve the researcher identity and where it came from, or null when
 * nothing is configured. Non-throwing on an unset identity — for readable
 * state (`config show`, `setup`); writes use `resolveResearcherId`. */
export function resolveIdentity(opts: IdentityOptions = {}): ResearcherIdentity | null {
  const env = opts.env ?? process.env
  const readGit = opts.gitConfig ?? readGitConfig
  const git = (key: 'user.email' | 'user.name', cwd: string | undefined) =>
    nonEmpty(readGit(key, cwd))
  const seed = seedUser(opts.seedPath)
  const global = globalUser(env)

  // Name resolves independently of the email, git-style. Lazily: only shell
  // out to git when nothing nearer answers.
  const name = (): string | null =>
    seed.name ?? global.name ?? git('user.name', opts.seedPath) ?? null

  const explicit = nonEmpty(opts.explicit)
  if (explicit !== undefined) {
    return { id: explicit, name: name(), source: 'flag', source_detail: '--researcher' }
  }
  const fromEnv = nonEmpty(env.COMPOST_USER)
  if (fromEnv !== undefined) {
    return { id: fromEnv, name: name(), source: 'env', source_detail: '$COMPOST_USER' }
  }
  if (seed.email !== undefined) {
    return { id: seed.email, name: name(), source: 'seed_config', source_detail: seed.path }
  }
  if (global.email !== undefined) {
    return { id: global.email, name: name(), source: 'global_config', source_detail: global.path }
  }
  const gitEmail = git('user.email', opts.seedPath)
  if (gitEmail !== undefined) {
    return { id: gitEmail, name: name(), source: 'git', source_detail: 'git config user.email' }
  }
  return null
}

/**
 * The researcher id for a researcher-authored write. Throws `IDENTITY_UNSET`
 * (with the exact fix) when nothing resolves — the refusal applies only here;
 * agent / AI actors are unaffected.
 */
export function resolveResearcherId(opts: IdentityOptions = {}): string {
  const identity = resolveIdentity(opts)
  if (identity !== null) return identity.id
  throw new CompostError(
    'IDENTITY_UNSET',
    `Researcher identity is not set, so this researcher-authored write was refused (no --researcher, $COMPOST_USER, user.email in the seed or global compost config, or git user.email). Tell compost who you are:\n  ${SET_IDENTITY_COMMAND}\n(optionally also: compost config set user.name "Your Name" --global; drop --global to set it for this seed only, or export COMPOST_USER=you@example.com for one shell).`,
  )
}
