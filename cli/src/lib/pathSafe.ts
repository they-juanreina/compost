import { isAbsolute, relative, sep } from 'node:path'

/**
 * True when `target` resolves to a path strictly inside `root` — not `root`
 * itself, and not escaping via `..`. Lexical only (does not resolve symlinks);
 * the shared predicate behind the seed and session containment guards (#211).
 * Callers that want to allow `target === root` test that case separately.
 */
export function isContainedUnder(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(`..${sep}`)
}
