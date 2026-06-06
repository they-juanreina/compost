import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { CompostError } from '../errors.js'

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
  const rel = relative(root, seedPath)
  if (rel.startsWith('..') || isAbsolute(rel) || rel.includes(`..${sep}`)) {
    throw new CompostError('INVALID_INPUT', `--seed resolves outside the Seeds/ root: ${seedPath}`)
  }
}

/**
 * Resolve a seed directory path. If `seed` is given, use Seeds/<seed>.
 * Otherwise require exactly one seed under ./Seeds and return it.
 *
 * Hardening (#211): the `seed` argument must not contain path separators or
 * `..` segments, and the resolved path is asserted to live under
 * `<cwd>/Seeds/` (belt-and-braces — if the deny-list ever misses an edge case,
 * the containment check catches the escape before any fs op).
 */
export function resolveSeedPath(cwd: string, seed?: string): string {
  const root = resolve(cwd, 'Seeds')
  if (!existsSync(root)) {
    throw new CompostError('NOT_IN_SEED', `No Seeds/ directory at ${root}`)
  }
  if (seed !== undefined) {
    assertSeedName(seed)
    const p = resolve(root, seed)
    assertContainedUnder(p, root)
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
