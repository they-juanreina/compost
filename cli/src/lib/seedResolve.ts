import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'

import { CompostError } from '../errors.js'
import { isContainedUnder } from './pathSafe.js'
import { loadUserConfigRaw, userConfigPath } from './userConfig.js'

/** Where the Seeds root came from — named in errors so a researcher can tell a
 * stale env var from a stale config key from "you ran this from the wrong
 * directory". */
export type SeedsRootSource = 'env' | 'global_config' | 'cwd'

export interface SeedsRoot {
  /** Absolute path of the directory that holds the seeds (`<root>/<seed>/`). */
  root: string
  source: SeedsRootSource
  /** Human label for the source: `$COMPOST_SEEDS_DIR`, the config file + key,
   * or `<cwd>/Seeds`. */
  source_detail: string
}

export interface SeedsRootOptions {
  cwd?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
}

/** The env var that names the Seeds root explicitly (#334). */
export const SEEDS_DIR_ENV = 'COMPOST_SEEDS_DIR'
/** The global (`~/.compost/config.toml`) key that names the Seeds root. */
export const SEEDS_DIR_CONFIG_KEY = 'seeds.dir'

const SET_ENV_FIX = `export ${SEEDS_DIR_ENV}=/absolute/path/to/Seeds (or unset it to use ./Seeds)`
const SET_CONFIG_FIX = `compost config set ${SEEDS_DIR_CONFIG_KEY} /absolute/path/to/Seeds --global (or remove the key to use ./Seeds)`

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

function assertAbsolute(value: string, label: string, fix: string): void {
  if (!isAbsolute(value)) {
    throw new CompostError(
      'CONFIG_ERROR',
      `${label} must be an absolute path to the Seeds directory; got ${JSON.stringify(value)} (relative paths and ~ are not expanded). Fix: ${fix}.`,
    )
  }
}

/**
 * The one place compost decides where seeds live (#334). Precedence:
 *
 *   1. `$COMPOST_SEEDS_DIR` — an absolute path to the Seeds directory itself
 *      (what a desktop-app MCP server entry sets: it has no cwd field);
 *   2. the global config key `seeds.dir` in `~/.compost/config.toml`
 *      (`compost config set seeds.dir /abs/path/Seeds --global`);
 *   3. `<cwd>/Seeds` — the historical default, unchanged when nothing is set.
 *
 * A relative explicit value is refused: it would silently depend on whatever
 * cwd the process happens to have, which is the bug this fixes. Does NOT check
 * existence; `requireSeedsRoot` does, naming the source.
 */
export function resolveSeedsRoot(opts: SeedsRootOptions = {}): SeedsRoot {
  const cwd = opts.cwd ?? process.cwd()
  const env = opts.env ?? process.env

  const fromEnv = nonEmpty(env[SEEDS_DIR_ENV])
  if (fromEnv !== undefined) {
    assertAbsolute(fromEnv, `$${SEEDS_DIR_ENV}`, SET_ENV_FIX)
    return { root: resolve(fromEnv), source: 'env', source_detail: `$${SEEDS_DIR_ENV}` }
  }

  const seedsTable = loadUserConfigRaw(env).seeds
  const configured =
    typeof seedsTable === 'object' && seedsTable !== null
      ? (seedsTable as Record<string, unknown>).dir
      : undefined
  if (configured !== undefined) {
    const detail = `${SEEDS_DIR_CONFIG_KEY} in ${userConfigPath(env)}`
    const value = nonEmpty(configured)
    if (value === undefined) {
      throw new CompostError(
        'CONFIG_ERROR',
        `${detail} must be a non-empty string path; got ${JSON.stringify(configured)}. Fix: ${SET_CONFIG_FIX}.`,
      )
    }
    assertAbsolute(value, detail, SET_CONFIG_FIX)
    return { root: resolve(value), source: 'global_config', source_detail: detail }
  }

  const root = resolve(cwd, 'Seeds')
  return { root, source: 'cwd', source_detail: './Seeds under the working directory' }
}

function missingRootFix(r: SeedsRoot): string {
  switch (r.source) {
    case 'env':
      return `Create it, or point $${SEEDS_DIR_ENV} at an existing Seeds directory (or unset it to use ./Seeds).`
    case 'global_config':
      return `Create it, or fix it: ${SET_CONFIG_FIX}.`
    case 'cwd':
      return `Run \`compost init <name>\` first, run from the directory that contains Seeds/, or set $${SEEDS_DIR_ENV}.`
  }
}

/** `resolveSeedsRoot`, then assert the directory exists. The error names the
 * source that supplied the path and how to fix it. */
export function requireSeedsRoot(opts: SeedsRootOptions = {}): SeedsRoot {
  const r = resolveSeedsRoot(opts)
  if (!existsSync(r.root)) {
    throw new CompostError(
      'NOT_IN_SEED',
      `No Seeds/ directory at ${r.root} (from ${r.source_detail}). ${missingRootFix(r)}`,
    )
  }
  return r
}

/** The seed's display name: its directory basename. The single way to derive a
 * name from a seed path — replaces an ad-hoc mix of `split('/').pop() ?? 'seed'`
 * (which mishandles Windows separators) and bare `basename`. Named `…Of` so it
 * doesn't shadow the conventional `const seedName` at call sites. */
export function seedNameOf(seedPath: string): string {
  return basename(seedPath)
}

/**
 * Seed names are labels, not paths (#211). We reject the patterns that let an
 * attacker escape the Seeds/ root: path separators, `..` segments, absolute
 * paths, and the empty string. Other characters (spaces, uppercase, accents)
 * are allowed so existing seed names from before this validation keep
 * working. The containment check below catches anything the deny-list misses.
 *
 * `initSeed` uses a stricter regex (`/^[a-z0-9][a-z0-9_-]*$/i`) for new seeds;
 * that's still enforced at creation. Resolution is more permissive for
 * backwards compat with any seed dir already on disk.
 */
function assertSeedName(seed: string): void {
  if (seed.length === 0) {
    throw new CompostError('INVALID_INPUT', '--seed cannot be empty')
  }
  if (seed.includes('/') || seed.includes('\\')) {
    throw new CompostError(
      'INVALID_INPUT',
      `--seed cannot contain path separators; got ${JSON.stringify(seed)}`,
    )
  }
  if (seed === '.' || seed === '..' || seed.split(sep).includes('..')) {
    throw new CompostError(
      'INVALID_INPUT',
      `--seed cannot contain '..' segments; got ${JSON.stringify(seed)}`,
    )
  }
  if (isAbsolute(seed)) {
    throw new CompostError(
      'INVALID_INPUT',
      `--seed must be a name, not an absolute path; got ${JSON.stringify(seed)}`,
    )
  }
}

function assertContainedUnder(seedPath: string, root: string): void {
  // seed is non-empty (assertSeedName), so seedPath never equals root here —
  // the strict isContainedUnder is equivalent for every reachable input.
  if (!isContainedUnder(root, seedPath)) {
    throw new CompostError('INVALID_INPUT', `--seed resolves outside the Seeds/ root: ${seedPath}`)
  }
}

/** `<root>/<seed>` with the #211 hardening (name deny-list, then containment
 * under the resolved root). No existence check. */
export function seedPathUnder(root: string, seed: string): string {
  assertSeedName(seed)
  const p = resolve(root, seed)
  assertContainedUnder(p, root)
  return p
}

/**
 * Resolve a seed directory path. If `seed` is given, use <root>/<seed>.
 * Otherwise require exactly one seed under the root and return it. The root
 * comes from `resolveSeedsRoot` ($COMPOST_SEEDS_DIR → global `seeds.dir` →
 * `<cwd>/Seeds`).
 *
 * Hardening (#211): the `seed` argument must not contain path separators or
 * `..` segments, and the resolved path is asserted to live under the resolved
 * root (belt-and-braces — if the deny-list ever misses an edge case, the
 * containment check catches the escape before any fs op).
 */
export function resolveSeedPath(
  cwd: string,
  seed?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { root } = requireSeedsRoot({ cwd, env })
  if (seed !== undefined) {
    const p = seedPathUnder(root, seed)
    if (!existsSync(p)) {
      throw new CompostError('NOT_IN_SEED', `Seed "${seed}" not found under ${root}`)
    }
    return p
  }
  const entries = readdirSync(root).filter(
    (e) => !e.startsWith('.') && statSync(join(root, e)).isDirectory(),
  )
  if (entries.length === 0) throw new CompostError('NOT_IN_SEED', `No seeds under ${root}`)
  if (entries.length > 1) {
    throw new CompostError(
      'INVALID_INPUT',
      `Multiple seeds under ${root} (${entries.join(', ')}). Pass --seed <name>.`,
    )
  }
  // biome-ignore lint/style/noNonNullAssertion: prior guards throw for length 0 and >1, so entries has exactly one element here
  return resolve(root, entries[0]!)
}
