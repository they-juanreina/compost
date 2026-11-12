import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

/**
 * User-level config at `~/.compost/config.toml`: machine-wide answers the
 * setup wizard collects once (model routing, provider tweaks) so every seed
 * scaffolded afterwards inherits them instead of the template's guesses.
 * Seeds stay the source of truth — the model/provider overlay is applied at
 * `compost init` time, never read at run time, so a shared seed behaves the
 * same on every machine.
 *
 * The one exception is the `[user]` table (`user.email`, `user.name`): the
 * researcher's git-style identity (ADR 0008), read at run time by
 * `lib/identity.ts` because identity belongs to the person, not the seed.
 * Written with `compost config set user.email … --global`.
 */
export interface UserConfig {
  defaults?: Record<string, string>
  providers?: Record<string, Record<string, unknown>>
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.COMPOST_HOME ?? join(homedir(), '.compost')
  return join(home, 'config.toml')
}

/** The whole user config as raw TOML, or `{}` when absent or unparseable (a
 * hand-edited broken file must not take a write path down with it). */
export function loadUserConfigRaw(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const path = userConfigPath(env)
  if (!existsSync(path)) return {}
  try {
    return parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Write the raw TOML object to the user config and return its path. */
export function saveUserConfigRaw(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = userConfigPath(env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${stringifyToml(raw)}\n`, 'utf8')
  return path
}

export function loadUserConfig(env: NodeJS.ProcessEnv = process.env): UserConfig | null {
  const path = userConfigPath(env)
  if (!existsSync(path)) return null
  try {
    const parsed = parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>
    const out: UserConfig = {}
    if (typeof parsed.defaults === 'object' && parsed.defaults !== null) {
      out.defaults = parsed.defaults as Record<string, string>
    }
    if (typeof parsed.providers === 'object' && parsed.providers !== null) {
      out.providers = parsed.providers as Record<string, Record<string, unknown>>
    }
    return out
  } catch {
    // A hand-edited broken file must not take `compost init` down with it.
    return null
  }
}

/** Merge new values into the user config on disk and return its path. */
export function saveUserConfig(update: UserConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = userConfigPath(env)
  const existing = loadUserConfig(env) ?? {}
  const merged: UserConfig = {
    defaults: { ...existing.defaults, ...update.defaults },
    providers: { ...existing.providers, ...update.providers },
  }
  // Keep every other table (e.g. `[user]`, the identity) — the wizard only
  // owns `defaults` and `providers`.
  const doc: Record<string, unknown> = { ...loadUserConfigRaw(env) }
  delete doc.defaults
  delete doc.providers
  if (merged.defaults && Object.keys(merged.defaults).length > 0) doc.defaults = merged.defaults
  if (merged.providers && Object.keys(merged.providers).length > 0) doc.providers = merged.providers
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${stringifyToml(doc)}\n`, 'utf8')
  return path
}

/** Overlay the user config onto a freshly-rendered seed config.toml. Comments
 * in the template are lost for the overridden file — acceptable at scaffold
 * time, where the researcher hasn't edited anything yet. Returns the input
 * unchanged when there's nothing to overlay. */
export function applyUserConfig(seedConfigToml: string, user: UserConfig | null): string {
  if (user === null || (user.defaults === undefined && user.providers === undefined)) {
    return seedConfigToml
  }
  const doc = parseToml(seedConfigToml) as Record<string, unknown>
  if (user.defaults) {
    doc.defaults = { ...(doc.defaults as Record<string, unknown>), ...user.defaults }
  }
  if (user.providers) {
    const providers = { ...(doc.providers as Record<string, Record<string, unknown>>) }
    for (const [name, settings] of Object.entries(user.providers)) {
      providers[name] = { ...providers[name], ...settings }
    }
    doc.providers = providers
  }
  return `${stringifyToml(doc)}\n`
}
