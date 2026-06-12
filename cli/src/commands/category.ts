import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { createCategory, defaultResearcherId } from '../lib/artifacts.js'
import {
  linkCodeToCategory,
  listCategories,
  listCategoryLinks,
  resolveCategory,
  unlinkCodeFromCategory,
} from '../lib/categories.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface NewFlags {
  definition: string
  codebook?: string
  seed?: string
}
interface SeedFlags {
  seed?: string
}
interface LinkFlags {
  seed?: string
  primary?: boolean
  noPrimary?: boolean
}

export function registerCategory(program: Command): void {
  const category = program
    .command('category')
    .description(
      'Manage categories — the second-cycle pattern-coding tier grouping codes within a codebook (ADR 0002)',
    )

  category
    .command('new')
    .description('Create a category (a codebook-internal grouping of codes)')
    .argument('<name>', 'Category name (slugified for the CAT- id)')
    .requiredOption('--definition <text>', 'What unifies the codes in this category')
    .option('--codebook <ref>', 'Codebook this category belongs to (default: primary)')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((name: string, flags: NewFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const created = createCategory(seedPath, {
          name,
          definition: flags.definition,
          ...(flags.codebook !== undefined ? { codebookId: flags.codebook } : {}),
          author: { actorType: 'researcher', actorId: defaultResearcherId() },
        })
        emit(
          {
            status: 'ok',
            command: 'category new',
            id: created.id,
            artifact_id: created.artifact_id,
            path: created.path,
            event_id: created.event_id,
          },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  category
    .command('list')
    .description("List the seed's categories and their code membership")
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((flags: SeedFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const links = listCategoryLinks(seedPath)
        const categories = listCategories(seedPath).map((snap) => {
          const s = snap.current_state as {
            id?: string
            name?: string
            codebook_id?: string
            definition?: string
          }
          const members = links
            .filter((l) => l.category === s.id)
            .map((l) => ({ code: l.code, is_primary: l.is_primary }))
          return {
            id: s.id,
            name: s.name,
            codebook_id: s.codebook_id,
            artifact_id: snap.artifact_id,
            human_approved: snap.human_approved,
            members,
          }
        })
        emit({ status: 'ok', command: 'category list', count: categories.length, categories }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  category
    .command('link')
    .description(
      "Link a code to a category (first link is the code's primary home unless --no-primary)",
    )
    .argument('<code>', 'Code id (e.g. C-distrust)')
    .argument('<category>', 'Category name or CAT- id')
    .option('--primary', "Make this the code's primary category (demotes any existing primary)")
    .option('--no-primary', 'Link as a secondary (axial) relationship')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((code: string, categoryRef: string, flags: LinkFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const cat = resolveCategory(seedPath, categoryRef)
        // commander sets flags.primary=false for --no-primary, true for --primary,
        // undefined when neither given (default: primary iff the code has none).
        const primary = flags.primary === false ? false : flags.primary === true ? true : undefined
        const result = linkCodeToCategory(seedPath, {
          code,
          category: cat.id,
          codebookId: cat.codebook_id,
          ...(primary !== undefined ? { primary } : {}),
          author: { actorType: 'researcher', actorId: defaultResearcherId() },
        })
        emit({ status: 'ok', command: 'category link', ...result }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  category
    .command('unlink')
    .description('Unlink a code from a category (archives the relationship; append-only)')
    .argument('<code>', 'Code id')
    .argument('<category>', 'Category name or CAT- id')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((code: string, categoryRef: string, flags: SeedFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const cat = resolveCategory(seedPath, categoryRef)
        const result = unlinkCodeFromCategory(seedPath, {
          code,
          category: cat.id,
          author: { actorType: 'researcher', actorId: defaultResearcherId() },
        })
        emit({ status: 'ok', command: 'category unlink', code, category: cat.id, ...result }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
