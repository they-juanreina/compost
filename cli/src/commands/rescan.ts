import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { loadEmbeddedHighlights } from '../lib/embeddedHighlights.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { suggestThemesOnce } from '../loops/synthesis.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface RescanFlags {
  seed?: string
  threshold?: string
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
