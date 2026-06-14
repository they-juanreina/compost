import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { CompostError } from '../errors.js'
import { isCanonicalSession } from './canonicalSessions.js'
import { codeMarkdownPaths } from './codeRefs.js'
import { JobQueue, stateDbPath } from './queue.js'

export interface SessionCounts {
  total: number
  transcribed: number
  queued: number
  inbox: number
}

export interface SeedCounts {
  sessions: SessionCounts
  highlights: number
  codes: number
  themes: number
  memos: number
  frames: number
  insights: number
  legacy_assets: number
}

export interface SeedStatus {
  name: string
  path: string
  status: string | null
  owners: string[]
  created_at: string | null
  counts: SeedCounts
  /** Non-canonical content found under the seed (e.g. legacy folders that
   * survived migration). Empty when the seed is clean. */
  warnings: string[]
}

export interface StatusSnapshot {
  schema_version: '1.0'
  generated_at: string
  root: string
  seeds: SeedStatus[]
}

export interface StatusOptions {
  cwd?: string
  seed?: string
  now?: () => Date
}

export function gatherStatus(opts: StatusOptions = {}): StatusSnapshot {
  const cwd = opts.cwd ?? process.cwd()
  const now = (opts.now ?? (() => new Date()))()
  const root = resolve(cwd, 'Seeds')

  if (!existsSync(root)) {
    throw new CompostError(
      'NOT_IN_SEED',
      `No Seeds/ directory at ${root}. Run \`compost init <name>\` first.`,
    )
  }

  const seedNames = readdirSync(root).filter((entry) => {
    if (entry.startsWith('.')) return false
    return statSync(join(root, entry)).isDirectory()
  })

  const filtered = opts.seed !== undefined ? seedNames.filter((n) => n === opts.seed) : seedNames

  if (opts.seed !== undefined && filtered.length === 0) {
    throw new CompostError('NOT_IN_SEED', `Seed "${opts.seed}" not found under ${root}`)
  }

  filtered.sort()
  const seeds = filtered.map((name) => readSeed(name, join(root, name)))

  return {
    schema_version: '1.0',
    generated_at: now.toISOString(),
    root,
    seeds,
  }
}

function readSeed(name: string, path: string): SeedStatus {
  const frontmatter = readFrontmatter(join(path, 'seed.md'))
  const warnings: string[] = []
  // A session without transcript.json counts as "queued" below, but if its job
  // burned all attempts nothing will ever process it — surface that here so
  // "queued" isn't read as "in progress" (#239).
  const deadJobs = countDeadJobs(path)
  if (deadJobs > 0) {
    warnings.push(
      `${deadJobs} permanently failed job(s) in the queue — run \`compost jobs requeue\``,
    )
  }
  return {
    name,
    path,
    status: frontmatter.status ?? null,
    owners: frontmatter.owners ?? [],
    created_at: frontmatter.created_at ?? null,
    counts: {
      sessions: countSessions(join(path, 'sessions'), warnings),
      highlights: countMarkdown(join(path, 'highlights')),
      codes: codeMarkdownPaths(path).length, // both layouts (#269)
      themes: countMarkdown(join(path, 'synthesis', 'themes')),
      memos: countMarkdown(join(path, 'synthesis', 'memos')),
      insights: countMarkdown(join(path, 'synthesis', 'insights')),
      frames: countFrames(join(path, 'sessions')),
      legacy_assets: countFiles(join(path, 'legacy')),
    },
    warnings,
  }
}

function countDeadJobs(seedPath: string): number {
  // Guard on existence: status is read-only and must not scaffold .compost/
  // state into a seed that never ran the watcher.
  if (!existsSync(stateDbPath(seedPath))) return 0
  const queue = new JobQueue(stateDbPath(seedPath))
  try {
    return queue.counts().failed
  } finally {
    queue.close()
  }
}

function countSessions(sessionsDir: string, warnings: string[]): SessionCounts {
  const counts: SessionCounts = { total: 0, transcribed: 0, queued: 0, inbox: 0 }
  if (!existsSync(sessionsDir)) return counts
  for (const entry of readdirSync(sessionsDir)) {
    const abs = join(sessionsDir, entry)
    if (!statSync(abs).isDirectory()) continue
    if (entry === '_inbox') {
      counts.inbox = readdirSync(abs).filter((f) => !f.startsWith('.')).length
      continue
    }
    if (!isCanonicalSession(abs, entry)) {
      warnings.push(`sessions/${entry}: not a canonical session shape (skipped)`)
      continue
    }
    counts.total += 1
    if (existsSync(join(abs, 'transcript.json'))) counts.transcribed += 1
    else counts.queued += 1
  }
  return counts
}

function countMarkdown(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const abs = join(dir, entry)
    const s = statSync(abs)
    if (s.isFile() && entry.endsWith('.md') && entry.toLowerCase() !== 'readme.md') total += 1
    else if (s.isDirectory()) total += countMarkdown(abs)
  }
  return total
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const abs = join(dir, entry)
    const s = statSync(abs)
    if (s.isFile()) total += 1
    else if (s.isDirectory()) total += countFiles(abs)
  }
  return total
}

function countFrames(sessionsDir: string): number {
  if (!existsSync(sessionsDir)) return 0
  let total = 0
  for (const entry of readdirSync(sessionsDir)) {
    if (entry === '_inbox') continue
    const framesDir = join(sessionsDir, entry, 'frames')
    if (!existsSync(framesDir)) continue
    total += readdirSync(framesDir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).length
  }
  return total
}

interface Frontmatter {
  status?: string
  created_at?: string
  owners?: string[]
}

function readFrontmatter(path: string): Frontmatter {
  if (!existsSync(path)) return {}
  const content = readFileSync(path, 'utf8')
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (match === null) return {}
  return parseSimpleYaml(match[1] ?? '')
}

function parseSimpleYaml(yaml: string): Frontmatter {
  const out: Frontmatter = {}
  const lines = yaml.split('\n')
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (m === null) continue
    const key = m[1]
    const value = (m[2] ?? '').trim()
    if (key === undefined) continue
    if (key === 'status' && value.length > 0) {
      out.status = stripQuotes(value)
    } else if (key === 'created_at' && value.length > 0) {
      out.created_at = stripQuotes(value)
    } else if (key === 'owners') {
      out.owners = parseOwners(value)
    }
  }
  return out
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function parseOwners(value: string): string[] {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed === '[]') return []
  const inline = trimmed.match(/^\[(.*)\]$/)
  const body = inline?.[1]
  if (body !== undefined) {
    return body
      .split(',')
      .map((part) => stripQuotes(part.trim()))
      .filter((s) => s.length > 0)
  }
  // Flow-style only for v1 — block-style "- name" lists not yet supported.
  return []
}
