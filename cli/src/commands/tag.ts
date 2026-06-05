import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { listCanonicalSessionIds } from '../lib/canonicalSessions.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { tagSeed } from '../lib/tagcode.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface TagFlags {
  seed?: string
  apply?: boolean
}

function loadUtterances(seedPath: string): Array<{ text: string }> {
  const sessionsDir = join(seedPath, 'sessions')
  const out: Array<{ text: string }> = []
  // Only scan canonical sessions (#171): pre-fix tag walked every subdir of
  // sessions/ that had a transcript.json — incl. legacy folders left behind
  // by partial migrations — which leaked non-canonical content (incl. raw
  // `.srt`-like timestamps) into the noun-phrase frequencies. Sharing the
  // resolver with status/saturate (#166) keeps the session set consistent.
  for (const entry of listCanonicalSessionIds(sessionsDir)) {
    const t = join(sessionsDir, entry, 'transcript.json')
    if (!existsSync(t)) continue
    const parsed = JSON.parse(readFileSync(t, 'utf8')) as { utterances?: Array<{ text: string }> }
    for (const u of parsed.utterances ?? []) out.push({ text: u.text })
  }
  return out
}

export function registerTag(program: Command): void {
  program
    .command('tag')
    .description('Suggest (default) or --apply glossary terms from recurring noun phrases')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--apply', 'Write suggested terms to glossary/glossary.md and emit events')
    .action((flags: TagFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const result = tagSeed(seedPath, loadUtterances(seedPath), { apply: flags.apply === true })
        emit({ status: 'ok', command: 'tag', ...result }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
