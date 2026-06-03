import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { CompostError } from '../errors.js'

/**
 * Resolve a seed directory path. If `seed` is given, use Seeds/<seed>.
 * Otherwise require exactly one seed under ./Seeds and return it.
 */
export function resolveSeedPath(cwd: string, seed?: string): string {
  const root = resolve(cwd, 'Seeds')
  if (!existsSync(root)) {
    throw new CompostError('NOT_IN_SEED', `No Seeds/ directory at ${root}`)
  }
  if (seed !== undefined) {
    const p = join(root, seed)
    if (!existsSync(p))
      throw new CompostError('NOT_IN_SEED', `Seed "${seed}" not found under ${root}`)
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
  return join(root, entries[0]!)
}
