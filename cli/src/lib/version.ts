import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveFetch } from '../llm/http.js'
import type { FetchLike } from '../llm/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PACKAGE_NAME = '@they-juanreina/compost-cli'
export const UPGRADE_COMMAND = `npm install -g ${PACKAGE_NAME}@latest`

/** The version of the running CLI, read from the package manifest (single
 * source of truth — works for src/lib and dist/lib alike, both two levels
 * below the package root). */
export function currentCliVersion(): string {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
  ) as { version?: string }
  return manifest.version ?? '0.0.0'
}

/**
 * Semver-ish comparison sufficient for our own release stream: numeric
 * major.minor.patch, with any prerelease ordering BELOW its release
 * (`0.1.0-rc.2 < 0.1.0 < 0.1.2`). Returns <0, 0, >0 like a comparator.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const [core = '', ...preParts] = v.replace(/^v/, '').split('-')
    return {
      nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: preParts.join('-'),
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === '') return 1 // release > its prereleases
  if (pb.pre === '') return -1
  return pa.pre < pb.pre ? -1 : 1
}

export interface VersionStatus {
  current: string
  latest: string
  behind: boolean
}

/**
 * Best-effort staleness probe against the npm registry (#245). Returns null on
 * ANY failure — offline machines and registry hiccups must never degrade
 * `compost setup`, they just skip the check. The timeout is deliberately
 * short: this is a courtesy warning, not a gate.
 */
export async function checkVersionStatus(deps: {
  fetchImpl?: FetchLike
  current?: string
  timeoutMs?: number
}): Promise<VersionStatus | null> {
  const fetchImpl = resolveFetch(deps.fetchImpl)
  const current = deps.current ?? currentCliVersion()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 2500)
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`, {
      method: 'GET',
      signal: controller.signal,
    })
    if (!res.ok) return null
    const tags = (await res.json()) as { latest?: string }
    if (typeof tags.latest !== 'string') return null
    return { current, latest: tags.latest, behind: compareVersions(current, tags.latest) < 0 }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
