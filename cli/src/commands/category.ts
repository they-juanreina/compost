import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { createCategory, DEFAULT_CODEBOOK_ID, defaultResearcherId } from '../lib/artifacts.js'
import {
  linkCodeToCategory,
  listCategories,
  listCategoryLinks,
  resolveCategory,
  unlinkCodeFromCategory,
} from '../lib/categories.js'
import { loadHighlightVectorMap } from '../lib/embeddedHighlights.js'
import { listArtifacts } from '../lib/reads.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { type CodeForCategorizing, suggestCategoriesOnce } from '../loops/synthesis.js'
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
interface SuggestFlags {
  seed?: string
  threshold?: string
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
            status?: string
            members?: string[]
          }
          // Named (created) categories carry committed links; AI [draft]
          // categories (from `category suggest`) carry no id/name yet — their
          // proposed grouping lives in members[] until a researcher endorses.
          const id = s.id ?? snap.artifact_id
          const committed = links
            .filter((l) => l.category === id)
            .map((l) => ({ code: l.code, is_primary: l.is_primary }))
          const isDraft = s.status === 'draft'
          return {
            id,
            name: s.name,
            codebook_id: s.codebook_id,
            artifact_id: snap.artifact_id,
            human_approved: snap.human_approved,
            ...(isDraft ? { status: 'draft' as const } : {}),
            members: committed,
            // The AI's proposed member codes (drafts only) — surfaced so the
            // suggestion isn't inert; endorsing materializes committed links.
            ...(isDraft && Array.isArray(s.members) ? { proposed_members: s.members } : {}),
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
    .command('suggest')
    .description(
      'Cluster codes by the centroid of their evidence embeddings (within each codebook) and draft AI [draft] categories. Requires embedded highlights (run `compost watch --once`). Drafts await researcher endorsement.',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--threshold <n>', 'Cosine similarity threshold for clustering', '0.75')
    .action((flags: SuggestFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const highlightVectors = loadHighlightVectorMap(seedPath)
        const codes: CodeForCategorizing[] = listArtifacts(seedPath, 'code')
          .map((snap) => {
            const s = snap.current_state as {
              id?: string
              evidence?: string[]
              codebook_id?: string
            }
            return {
              id: typeof s.id === 'string' ? s.id : snap.artifact_id,
              evidence: Array.isArray(s.evidence) ? s.evidence : [],
              codebook_id: typeof s.codebook_id === 'string' ? s.codebook_id : DEFAULT_CODEBOOK_ID,
            }
          })
          .filter((c) => c.evidence.length > 0)
        const suggestions = suggestCategoriesOnce(seedPath, codes, highlightVectors, {
          threshold: Number(flags.threshold ?? 0.75),
        })
        emit(
          {
            status: 'ok',
            command: 'category suggest',
            embedded_highlights: highlightVectors.size,
            codes_positioned: codes.filter((c) => c.evidence.some((h) => highlightVectors.has(h)))
              .length,
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
