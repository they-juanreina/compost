import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CompostError } from '../errors.js'
import { loadTemplate, render } from './templates.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// templates/ is a sibling of src/ and dist/ (lib/ → ../../templates).
const SAMPLE_SEED_DIR = join(__dirname, '..', '..', 'templates', 'sample-seed')

const SEED_DIRECTORIES = [
  'plan',
  'sessions',
  'sessions/_inbox',
  'glossary',
  'highlights',
  'codebook',
  'synthesis',
  'exports',
  'legacy',
  '.compost',
  '.compost/logs',
  '.compost/work',
] as const

export interface InitOptions {
  cwd?: string
  force?: boolean
  now?: () => Date
  /** Unpack the bundled sample seed (a redacted single-session corpus). */
  fromSample?: boolean
}

export interface InitResult {
  seed_name: string
  path: string
  created_at: string
  files: string[]
  directories: string[]
}

export function initSeed(name: string, opts: InitOptions = {}): InitResult {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    throw new CompostError(
      'INVALID_INPUT',
      `Seed name must be alphanumeric with - or _ (got "${name}")`,
    )
  }

  const cwd = opts.cwd ?? process.cwd()
  const force = opts.force === true
  const now = (opts.now ?? (() => new Date()))()
  const seedPath = resolve(cwd, 'Seeds', name)
  const createdAt = now.toISOString()

  if (existsSync(seedPath) && !force) {
    throw new CompostError(
      'INVALID_INPUT',
      `Seed already exists at ${seedPath}. Use --force to overwrite.`,
    )
  }

  const createdDirs: string[] = []
  for (const dir of SEED_DIRECTORIES) {
    const abs = join(seedPath, dir)
    mkdirSync(abs, { recursive: true })
    createdDirs.push(dir)
  }

  const vars: Record<string, string> = { seed_name: name, created_at: createdAt }
  const files: Array<{ path: string; content: string }> = [
    { path: 'seed.md', content: render(loadTemplate('seed.md'), vars) },
    { path: '.compost/AGENTS.md', content: render(loadTemplate('AGENTS.md'), vars) },
    { path: '.compost/config.toml', content: render(loadTemplate('config.toml'), vars) },
  ]

  for (const file of files) {
    writeFileSync(join(seedPath, file.path), file.content, 'utf8')
  }

  // --from-sample: overlay the bundled sample corpus (sessions, highlights,
  // codes, theme) on top of the fresh scaffold. seed.md is replaced by the
  // sample's own.
  if (opts.fromSample === true) {
    cpSync(SAMPLE_SEED_DIR, seedPath, { recursive: true })
  }

  return {
    seed_name: name,
    path: seedPath,
    created_at: createdAt,
    files: files.map((f) => f.path),
    directories: createdDirs,
  }
}
