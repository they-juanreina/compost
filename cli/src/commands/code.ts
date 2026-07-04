import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { assertHighlightsEmbedded, loadEmbeddedHighlights } from '../lib/embeddedHighlights.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { suggestThemesOnce } from '../loops/synthesis.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface CodeFlags {
  seed?: string
  apply?: boolean
  threshold?: string
}

export function registerCode(program: Command): void {
  program
    .command('code')
    .description('Suggest (default) codes by clustering highlights; --apply emits them as drafts')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--apply', 'Emit the suggested codes as AI [draft] events')
    .option('--threshold <n>', 'Cosine clustering threshold', '0.75')
    .action((flags: CodeFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const highlights = loadEmbeddedHighlights(seedPath)
        assertHighlightsEmbedded(seedPath, highlights)
        // suggestThemesOnce emits the AI code drafts; with --apply we run it,
        // otherwise we report what it *would* suggest (dry preview).
        if (flags.apply === true) {
          const suggestions = suggestThemesOnce(seedPath, highlights, {
            threshold: Number(flags.threshold ?? 0.75),
          })
          emit(
            {
              status: 'ok',
              command: 'code',
              applied: true,
              suggested: suggestions.length,
              suggestions,
            },
            out,
          )
        } else {
          // dry preview: cluster without emitting (re-run with apply to persist)
          emit(
            {
              status: 'ok',
              command: 'code',
              applied: false,
              embedded_highlights: highlights.length,
              note: 'run with --apply to emit code drafts',
            },
            out,
          )
        }
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
