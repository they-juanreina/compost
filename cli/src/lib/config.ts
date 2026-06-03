import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse as parseToml } from 'smol-toml'

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
