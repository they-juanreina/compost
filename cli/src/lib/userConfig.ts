import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

/**
 * User-level config at `~/.compost/config.toml`: machine-wide answers the
 * setup wizard collects once (model routing, provider tweaks) so every seed
 * scaffolded afterwards inherits them instead of the template's guesses.
 * Seeds stay the source of truth — this file is only an overlay applied at
 * `compost init` time, never read at run time, so a shared seed behaves the
 * same on every machine.
 */
export interface UserConfig {
  defaults?: Record<string, string>
  providers?: Record<string, Record<string, unknown>>
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.COMPOST_HOME ?? join(homedir(), '.compost')
  return join(home, 'config.toml')
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
  const doc: Record<string, unknown> = {}
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
