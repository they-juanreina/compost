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

/** The set of types `compost config set --type=<X>` accepts. */
export type ConfigValueType = 'string' | 'bool' | 'int' | 'float' | 'json'

/**
 * Set a dotted key in the raw TOML object.
 *
 * Default behavior: store the value as a **string**. This matches `git config`,
 * `gh config`, `aws configure`: leaf values are strings unless explicitly
 * typed otherwise. This eliminates silent type drift (a researcher typing
 * `compost config set features.beta true` previously stored a boolean and
 * later confused `cfg.features.beta === "true"` checks).
 *
 * To store a non-string type, pass `type`:
 *   - `bool`  → 'true' | 'false'
 *   - `int`   → integer (must match /^-?\d+$/)
 *   - `float` → decimal (must match /^-?\d+(\.\d+)?$/)
 *   - `json`  → JSON.parse the value (arrays, objects, nested structures)
 *
 * Agents writing config programmatically should always pass `type` to be
 * explicit. Humans typing strings can leave it off.
 */
export function setConfigValue(
  raw: Record<string, unknown>,
  key: string,
  value: string,
  type: ConfigValueType = 'string',
): void {
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
  cursor[parts[parts.length - 1] as string] = coerceTyped(value, type)
}

function coerceTyped(value: string, type: ConfigValueType): unknown {
  switch (type) {
    case 'string':
      return value
    case 'bool':
      if (value === 'true') return true
      if (value === 'false') return false
      throw new CompostError(
        'INVALID_INPUT',
        `--type=bool requires "true" or "false"; got ${JSON.stringify(value)}`,
      )
    case 'int': {
      if (!/^-?\d+$/.test(value)) {
        throw new CompostError(
          'INVALID_INPUT',
          `--type=int requires an integer; got ${JSON.stringify(value)}`,
        )
      }
      const n = Number(value)
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new CompostError(
          'INVALID_INPUT',
          `--type=int value out of range: ${JSON.stringify(value)}`,
        )
      }
      return n
    }
    case 'float': {
      if (!/^-?\d+(\.\d+)?$/.test(value)) {
        throw new CompostError(
          'INVALID_INPUT',
          `--type=float requires a decimal number; got ${JSON.stringify(value)}`,
        )
      }
      const n = Number(value)
      if (!Number.isFinite(n)) {
        throw new CompostError(
          'INVALID_INPUT',
          `--type=float value not finite: ${JSON.stringify(value)}`,
        )
      }
      return n
    }
    case 'json':
      try {
        return JSON.parse(value)
      } catch (cause) {
        throw new CompostError('INVALID_INPUT', `--type=json: invalid JSON: ${value}`, { cause })
      }
  }
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
