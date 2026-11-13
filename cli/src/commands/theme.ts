import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { editThemeEvidence } from '../lib/themeEvidence.js'
import { parseEvidence } from '../lib/themes.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { renderThemeEvidenceEdit } from '../render/human.js'
import { addAuthorFlags, type CommonFlags, resolveAuthor } from './create.js'

interface ThemeEvidenceFlags extends CommonFlags {
  evidence: string
}

const THEME_ARG = 'Theme id (T-slug, as printed by `compost create theme`) or SHA256 prefix'

/**
 * `compost theme add|remove <theme> --evidence …` (#335). A thin adapter: parse
 * flags, call `editThemeEvidence`, render. Every rule — who may edit, what may
 * be cited, the frame and empty-set invariants, the event, the markdown
 * restamp — lives in `lib/themeEvidence.ts`.
 */
export function registerTheme(program: Command): void {
  const theme = program
    .command('theme')
    .description(
      "Edit an existing theme's evidence set — add or remove codes / categories (one update event per change)",
    )
    .addHelpText(
      'after',
      "\nA theme keeps its lens: a single-lens theme only takes evidence from its own codebook, a cross-lens theme keeps ≥2. Removing a theme's last code/category is refused — retire it with `compost reject <theme>`. Adding what is already there, or removing what is not, changes nothing and emits no event.\n\nExamples:\n  $ compost theme add T-control --evidence code:C-override,category:CAT-agency\n  $ compost theme remove T-control --evidence C-distrust\n  $ compost list theme --evidence          # see the result",
    )

  for (const op of ['add', 'remove'] as const) {
    addAuthorFlags(
      theme
        .command(op)
        .description(
          op === 'add'
            ? 'Add code / category evidence to a theme'
            : 'Remove evidence from a theme (never its last code / category)',
        )
        .argument('<theme>', THEME_ARG)
        .requiredOption(
          '--evidence <refs>',
          `Comma-separated kind:ref to ${op} (code:C-distrust,category:CAT-trust); a bare ref is a code`,
        ),
      'update',
    ).action((themeRef: string, flags: ThemeEvidenceFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const refs = parseEvidence(flags.evidence)
        const result = editThemeEvidence(
          seedPath,
          themeRef,
          op === 'add' ? { add: refs } : { remove: refs },
          resolveAuthor(flags, seedPath),
        )
        emit(
          { status: result.changed ? 'ok' : 'unchanged', command: `theme ${op}`, ...result },
          out,
          renderThemeEvidenceEdit,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
  }
}
