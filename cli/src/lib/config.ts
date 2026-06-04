import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

import { CompostError } from '../errors.js'

export interface ProviderSettings {
  base_url?: string
  api_key_env?: string
}

export interface CompostConfig {
  providers: Record<string, ProviderSettings>
  defaults: Record<string, string>
  raw: Record<string, unknown>
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
}

export function parseConfig(tomlText: string): CompostConfig {
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(tomlText) as Record<string, unknown>
  } catch (cause) {
    throw new CompostError('CONFIG_ERROR', 'Could not parse config.toml', { cause })
  }
  const providers = (parsed.providers as Record<string, ProviderSettings>) ?? {}
  const defaults = (parsed.defaults as Record<string, string>) ?? {}
  return { providers, defaults, raw: parsed }
}

export function loadConfig(seedPath: string): CompostConfig {
  const configPath = join(seedPath, '.compost', 'config.toml')
  if (!existsSync(configPath)) {
    throw new CompostError('CONFIG_ERROR', `No config.toml at ${configPath}`)
  }
  return parseConfig(readFileSync(configPath, 'utf8'))
}

export function providerBaseUrl(config: CompostConfig, providerName: string): string {
  return config.providers[providerName]?.base_url ?? DEFAULT_BASE_URLS[providerName] ?? ''
}

export function providerApiKey(config: CompostConfig, providerName: string): string | undefined {
  const envName = config.providers[providerName]?.api_key_env
  if (envName === undefined) return undefined
  return process.env[envName]
}

/** Resolve a dotted key (e.g. `providers.ollama.base_url`) against the raw TOML
 * object. Returns undefined if any segment is missing. */
export function getConfigValue(raw: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.')
  let cursor: unknown = raw
  for (const part of parts) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
    if (cursor === undefined) return undefined
  }
  return cursor
}

/** Set a dotted key in the raw TOML object. Coerces simple JSON-y types
 * ("true", "42", "[a,b]") at the leaf; strings pass through unchanged. */
export function setConfigValue(raw: Record<string, unknown>, key: string, value: string): void {
  const parts = key.split('.')
  if (parts.length === 0) {
    throw new CompostError('INVALID_INPUT', 'Empty config key')
  }
  let cursor: Record<string, unknown> = raw
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string
    const next = cursor[part]
    if (next === undefined || typeof next !== 'object' || next === null || Array.isArray(next)) {
      cursor[part] = {}
    }
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1] as string] = coerceValue(value)
}

function coerceValue(value: string): unknown {
  // Empty string → empty string, not undefined
  if (value.length === 0) return ''
  // Booleans
  if (value === 'true') return true
  if (value === 'false') return false
  // Integers and floats (no leading zeros except "0" itself)
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  // Try to parse as JSON for arrays/objects: `[a,b]`, `["a","b"]`
  if (
    (value.startsWith('[') && value.endsWith(']')) ||
    (value.startsWith('{') && value.endsWith('}'))
  ) {
    try {
      return JSON.parse(value)
    } catch {
      // fall through — leave as string
    }
  }
  // Quoted string — strip the quotes
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/** Write the raw TOML object back to .compost/config.toml. */
export function saveConfig(seedPath: string, raw: Record<string, unknown>): void {
  const configPath = join(seedPath, '.compost', 'config.toml')
  writeFileSync(configPath, stringifyToml(raw), 'utf8')
}

/** Parse a "provider:model" routing string (model may itself contain colons). */
export function parseRoute(route: string): { provider: string; model: string } {
  const idx = route.indexOf(':')
  if (idx === -1) {
    throw new CompostError(
      'CONFIG_ERROR',
      `Invalid route "${route}"; expected "provider:model" (e.g. ollama:llama3.1:8b)`,
    )
  }
  return { provider: route.slice(0, idx), model: route.slice(idx + 1) }
}
