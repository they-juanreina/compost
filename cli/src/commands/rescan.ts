import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { Command } from 'commander'
import type { EmbeddedItem } from 'compost-retrieval'

import { isCompostError } from '../errors.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { suggestThemesOnce } from '../loops/synthesis.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface RescanFlags {
  seed?: string
  threshold?: string
}

/** Load embedded highlights from highlights/*.json ({ id, vector } sidecars
 * written by the embed-worker). Empty when none are embedded yet. */
function loadEmbeddedHighlights(seedPath: string): EmbeddedItem[] {
  const dir = join(seedPath, 'highlights')
  if (!existsSync(dir)) return []
  const out: EmbeddedItem[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const p = join(dir, f)
    if (!statSync(p).isFile()) continue
    try {
      const j = JSON.parse(readFileSync(p, 'utf8')) as { id?: string; vector?: number[] }
      if (typeof j.id === 'string' && Array.isArray(j.vector))
        out.push({ id: j.id, vector: j.vector })
    } catch {
      // skip malformed sidecars
    }
  }
  return out
}

export function registerRescan(program: Command): void {
  program
    .command('rescan')
    .description(
      'Run the cross-session-similarity scanner: cluster un-coded highlights → AI code suggestions',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--threshold <n>', 'Cosine similarity threshold for clustering', '0.75')
    .action((flags: RescanFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const highlights = loadEmbeddedHighlights(seedPath)
        const suggestions = suggestThemesOnce(seedPath, highlights, {
          threshold: Number(flags.threshold ?? 0.75),
        })
        emit(
          {
            status: 'ok',
            command: 'rescan',
            embedded_highlights: highlights.length,
            suggested: suggestions.length,
            suggestions,
          },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
