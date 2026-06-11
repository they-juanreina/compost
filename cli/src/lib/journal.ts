import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { scrubbedEnv } from './childEnv.js'

// Prompt-journal version/diff logic (#62). The seed's .compost/AGENTS.md is
// the prompt journal loops read. When git is initialized the web UI commits on
// save; otherwise we append a timestamped version section so history is never
// lost. This module is the pure core consumed by the web page + a CLI command.

const VERSION_RE = /^<!-- compost:version (.+?) -->$/

export interface JournalVersion {
  ts: string
  body: string
}

/** Split an AGENTS.md into versioned sections. The leading content (before any
 * version marker) is the current working draft. */
export function parseVersions(content: string): { draft: string; versions: JournalVersion[] } {
  const lines = content.split('\n')
  const versions: JournalVersion[] = []
  const draftLines: string[] = []
  let current: JournalVersion | null = null
  for (const line of lines) {
    const m = VERSION_RE.exec(line)
    if (m !== null) {
      if (current !== null) versions.push(current)
      // biome-ignore lint/style/noNonNullAssertion: VERSION_RE has one capture group, guaranteed present on a match
      current = { ts: m[1]!, body: '' }
      continue
    }
    if (current === null) draftLines.push(line)
    else current.body += `${line}\n`
  }
  if (current !== null) versions.push(current)
  return {
    draft: draftLines.join('\n').trimEnd(),
    versions: versions.map((v) => ({ ts: v.ts, body: v.body.trimEnd() })),
  }
}

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
}

/** A minimal line-level diff (LCS) between two versions, for the diff view. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n')
  const y = b.split('\n')
  const n = x.length
  const m = y.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      // biome-ignore lint/style/noNonNullAssertion: lcs row i is in-bounds (0 <= i <= n) and pre-filled by Array.from
      lcs[i]![j] =
        // biome-ignore lint/style/noNonNullAssertion: lcs rows i and i+1 are in-bounds (i+1 <= n) and every cell is pre-filled with 0
        x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      // biome-ignore lint/style/noNonNullAssertion: loop guard i < n (= x.length) keeps x[i] in-bounds
      out.push({ type: 'ctx', text: x[i]! })
      i++
      j++
      // biome-ignore lint/style/noNonNullAssertion: lcs rows i and i+1 are in-bounds (i+1 <= n) and every cell is pre-filled with 0
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      // biome-ignore lint/style/noNonNullAssertion: loop guard i < n (= x.length) keeps x[i] in-bounds
      out.push({ type: 'del', text: x[i]! })
      i++
    } else {
      // biome-ignore lint/style/noNonNullAssertion: loop guard j < m (= y.length) keeps y[j] in-bounds
      out.push({ type: 'add', text: y[j]! })
      j++
    }
  }
  // biome-ignore lint/style/noNonNullAssertion: loop guard i < n (= x.length) keeps x[i] in-bounds
  while (i < n) out.push({ type: 'del', text: x[i++]! })
  // biome-ignore lint/style/noNonNullAssertion: loop guard j < m (= y.length) keeps y[j] in-bounds
  while (j < m) out.push({ type: 'add', text: y[j++]! })
  return out
}

export function agentsPath(seedPath: string): string {
  return join(seedPath, '.compost', 'AGENTS.md')
}

export function readJournal(seedPath: string): string {
  const p = agentsPath(seedPath)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

/** Compose an AGENTS.md from a working draft + recorded inline versions. The
 * inverse of parseVersions, so save → load round-trips. */
function composeJournal(draft: string, versions: JournalVersion[]): string {
  const head = `${draft.trimEnd()}\n`
  if (versions.length === 0) return head
  const body = versions
    .map((v) => `\n<!-- compost:version ${v.ts} -->\n${v.body.trimEnd()}\n`)
    .join('')
  return `${head}${body}`
}

function isGitWorkTree(dir: string): boolean {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    env: scrubbedEnv(),
  })
  return r.status === 0 && r.stdout.trim() === 'true'
}

function gitCommitFile(dir: string, file: string, message: string): void {
  // git needs no compost secrets — don't expose tokens to hooks/credential helpers.
  spawnSync('git', ['-C', dir, 'add', '--', file], { encoding: 'utf8', env: scrubbedEnv() })
  spawnSync('git', ['-C', dir, 'commit', '-m', message, '--', file], {
    encoding: 'utf8',
    env: scrubbedEnv(),
  })
}

export type JournalSaveMode = 'git' | 'append'

export interface JournalSaveResult {
  mode: JournalSaveMode
  versions: number
}

/**
 * Save a new working draft of the seed's AGENTS.md and snapshot the prior one.
 * When the seed lives inside a git work tree the snapshot is a commit; otherwise
 * the prior draft is recorded as a timestamped inline version so history is
 * never lost. The new draft always becomes the top section either way, so the
 * version/diff UI keeps working. `ts` is supplied by the caller (no clock here).
 */
export function saveJournal(seedPath: string, newDraft: string, ts: string): JournalSaveResult {
  const p = agentsPath(seedPath)
  mkdirSync(dirname(p), { recursive: true })
  const prior = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const { draft: priorDraft, versions } = parseVersions(prior)

  if (isGitWorkTree(seedPath)) {
    // Git is the history store: write the new draft (preserving any pre-existing
    // inline versions for back-compat) and commit.
    writeFileSync(p, composeJournal(newDraft, versions), 'utf8')
    gitCommitFile(seedPath, p, `journal: update AGENTS.md @ ${ts}`)
    return { mode: 'git', versions: versions.length }
  }

  // Gitless: snapshot the prior draft as a timestamped inline version (newest
  // first), then set the new draft on top.
  const nextVersions =
    priorDraft.trim().length > 0 ? [{ ts, body: priorDraft }, ...versions] : versions
  writeFileSync(p, composeJournal(newDraft, nextVersions), 'utf8')
  return { mode: 'append', versions: nextVersions.length }
}
