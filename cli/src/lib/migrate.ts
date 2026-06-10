import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { CompostError } from '../errors.js'
import { loadTemplate, render } from './templates.js'

/** Folders that compost expects in a migrated seed, beyond the renamed legacy dirs. */
const SCAFFOLD_DIRS = [
  'glossary',
  'highlights',
  'codebook',
  'exports',
  'legacy',
  'sessions/_inbox',
  '.compost',
  '.compost/logs',
  '.compost/work',
] as const

const NUMBERED_PREFIX_RE = /^(\d+)[_-](.+)$/

export interface RenamePlan {
  from: string
  to: string
}

export interface MigratePlan {
  seed_name: string
  path: string
  already_migrated: boolean
  renames: RenamePlan[]
  scaffold_dirs: string[]
  scaffold_files: string[]
}

export interface MigrateOptions {
  apply?: boolean
  now?: () => Date
}

export interface MigrateResult extends MigratePlan {
  applied: boolean
}

/**
 * Map a legacy directory name to its compost equivalent.
 * Strips a leading numeric prefix (`01_`, `02-`, …) and lowercases the first
 * path segment. "01_Plan" → "plan", "02_Sessions" → "sessions",
 * "04_Evaluation" → "evaluation". Names without a numeric prefix are left alone.
 */
export function mapLegacyName(name: string): string {
  const m = NUMBERED_PREFIX_RE.exec(name)
  if (m === null) return name
  // biome-ignore lint/style/noNonNullAssertion: capture group 2 (.+) is required by the regex, so it is always present on a non-null match
  return m[2]!.toLowerCase()
}

export function planMigration(seedPath: string): MigratePlan {
  if (!existsSync(seedPath) || !statSync(seedPath).isDirectory()) {
    throw new CompostError('FILE_NOT_FOUND', `Not a directory: ${seedPath}`)
  }

  const entries = readdirSync(seedPath).filter((e) => {
    if (e.startsWith('.')) return false
    return statSync(join(seedPath, e)).isDirectory()
  })

  const renames: RenamePlan[] = []
  for (const entry of entries) {
    const mapped = mapLegacyName(entry)
    if (mapped !== entry) {
      renames.push({ from: entry, to: mapped })
    }
  }

  const alreadyMigrated = renames.length === 0 && existsSync(join(seedPath, '.compost'))

  const scaffoldDirs: string[] = []
  for (const dir of SCAFFOLD_DIRS) {
    if (!existsSync(join(seedPath, dir))) scaffoldDirs.push(dir)
  }

  const scaffoldFiles: string[] = []
  if (!existsSync(join(seedPath, '.compost', 'config.toml'))) {
    scaffoldFiles.push('.compost/config.toml')
  }
  if (!existsSync(join(seedPath, '.compost', 'AGENTS.md'))) {
    scaffoldFiles.push('.compost/AGENTS.md')
  }
  if (!existsSync(join(seedPath, 'seed.md'))) {
    scaffoldFiles.push('seed.md')
  }

  return {
    seed_name: basename(seedPath),
    path: seedPath,
    already_migrated: alreadyMigrated,
    renames,
    scaffold_dirs: scaffoldDirs,
    scaffold_files: scaffoldFiles,
  }
}

export function migrate(seedPath: string, opts: MigrateOptions = {}): MigrateResult {
  const plan = planMigration(seedPath)
  const apply = opts.apply === true

  if (!apply) {
    return { ...plan, applied: false }
  }

  // Guard: refuse to overwrite an existing target dir with a rename.
  for (const r of plan.renames) {
    if (existsSync(join(seedPath, r.to))) {
      throw new CompostError(
        'INVALID_INPUT',
        `Cannot rename "${r.from}" → "${r.to}": target already exists. Resolve manually.`,
      )
    }
  }

  // Apply renames, tracking completed ones so we can roll back on failure.
  const completed: RenamePlan[] = []
  try {
    for (const r of plan.renames) {
      renameSync(join(seedPath, r.from), join(seedPath, r.to))
      completed.push(r)
    }
  } catch (cause) {
    for (const done of completed.reverse()) {
      try {
        renameSync(join(seedPath, done.to), join(seedPath, done.from))
      } catch {
        // best-effort rollback; report the original failure
      }
    }
    throw new CompostError('IO_ERROR', `Migration failed during rename; rolled back`, { cause })
  }

  // Scaffold missing dirs + files (idempotent).
  for (const dir of plan.scaffold_dirs) {
    mkdirSync(join(seedPath, dir), { recursive: true })
  }

  const now = (opts.now ?? (() => new Date()))()
  const vars: Record<string, string> = {
    seed_name: plan.seed_name,
    created_at: now.toISOString(),
  }
  for (const file of plan.scaffold_files) {
    const templateName = file === 'seed.md' ? 'seed.md' : basename(file)
    // Write atomically (temp + rename) so a failure mid-write never leaves a
    // truncated config.toml/seed.md that re-runs would keep (existsSync guards
    // the scaffold, so a half-written file would otherwise never be repaired).
    const finalPath = join(seedPath, file)
    const tmpPath = `${finalPath}.tmp`
    writeFileSync(tmpPath, render(loadTemplate(templateName), vars), 'utf8')
    renameSync(tmpPath, finalPath)
  }

  return { ...plan, applied: true }
}
