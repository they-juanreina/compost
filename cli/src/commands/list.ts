import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { assertStateFilter, LISTABLE_KINDS, listByKind, STATE_FILTERS } from '../lib/list.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { renderList } from '../render/human.js'

interface ListFlags {
  seed?: string
  state?: string
  codebook?: string
  evidence?: boolean
}

export function registerList(program: Command): void {
  program
    .command('list')
    .description(
      'List highlights, codes, or themes with their trust state (draft / endorsed / archived) — what is awaiting endorsement',
    )
    .argument('<kind>', LISTABLE_KINDS.join(' | '))
    .option(
      '--state <state>',
      `${STATE_FILTERS.join(' | ')} (default: draft + endorsed, i.e. not archived)`,
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--codebook <ref>', 'Only codes / themes in this frame (name or CB- id)')
    .option(
      '--evidence',
      "Expand each item's evidence to quotes (code: its highlights; theme: its evidence set)",
    )
    .addHelpText(
      'after',
      '\nMemos, codebooks and categories have their own verbs: `compost memo list`, `compost codebook list`, `compost category list`.\n\nExamples:\n  $ compost list code --state draft\n  $ compost list theme --evidence --state all',
    )
    .action((kind: string, flags: ListFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const result = listByKind(seedPath, kind, {
          ...(flags.state !== undefined ? { state: assertStateFilter(flags.state) } : {}),
          ...(flags.codebook !== undefined ? { codebook: flags.codebook } : {}),
          ...(flags.evidence === true ? { evidence: true } : {}),
        })
        emit({ status: 'ok', command: 'list', ...result }, out, renderList)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
