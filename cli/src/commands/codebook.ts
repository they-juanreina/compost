import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import {
  CODEBOOK_STANCES,
  type CodebookStance,
  createCodebook,
  DEFAULT_CODEBOOK_ID,
  defaultResearcherId,
} from '../lib/artifacts.js'
import { applyCodebookMigration, listCodebooks, planCodebookMigration } from '../lib/codebooks.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { stubAction, stubDescription } from './_stub.js'

interface NewFlags {
  stance: string
  description?: string
  seed?: string
}

interface SeedFlags {
  seed?: string
}

interface MigrateFlags {
  seed?: string
  apply?: boolean
}

export function registerCodebook(program: Command): void {
  const codebook = program
    .command('codebook')
    .description('Manage codebooks — the interpretive lenses codes belong to (ADR 0001)')

  codebook
    .command('new')
    .description('Create a codebook with a declared stance')
    .argument('<name>', 'Codebook name (slugified for the CB- id)')
    .requiredOption('--stance <stance>', `Interpretive stance: ${CODEBOOK_STANCES.join(' | ')}`)
    .option('--description <text>', 'What this lens is for')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .addHelpText(
      'after',
      '\nExamples:\n  $ compost codebook new epistemology --stance framework\n  $ compost codebook new open-coding --stance inductive --description "First-pass emic reading"',
    )
    .action((name: string, flags: NewFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const created = createCodebook(seedPath, {
          name,
          stance: flags.stance as CodebookStance,
          ...(flags.description !== undefined ? { description: flags.description } : {}),
          author: { actorType: 'researcher', actorId: defaultResearcherId() },
        })
        emit(
          {
            status: 'ok',
            command: 'codebook new',
            id: created.id,
            artifact_id: created.artifact_id,
            stance: flags.stance,
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

  codebook
    .command('list')
    .description("List the seed's codebooks (event-log-derived, newest activity first)")
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((flags: SeedFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const codebooks = listCodebooks(seedPath).map((snap) => {
          const state = snap.current_state as {
            id?: string
            name?: string
            stance?: string
            description?: string
          }
          return {
            id: state.id,
            name: state.name,
            stance: state.stance,
            description: state.description,
            artifact_id: snap.artifact_id,
            version: snap.version,
            human_approved: snap.human_approved,
            implicit: false,
          }
        })
        // The primary codebook is the implicit default frame — every seed has
        // it, whether or not a `codebook` artifact has been materialized yet.
        // Synthesize it so codes stamped CB-primary never look frame-less; a
        // real artifact (with a customized stance/description) shadows it.
        if (!codebooks.some((c) => c.id === DEFAULT_CODEBOOK_ID)) {
          codebooks.unshift({
            id: DEFAULT_CODEBOOK_ID,
            name: 'primary',
            stance: 'inductive',
            description: 'Default frame (implicit). Customize with `compost codebook migrate`.',
            artifact_id: '',
            version: 0,
            human_approved: true,
            implicit: true,
          })
        }
        emit({ status: 'ok', command: 'codebook list', count: codebooks.length, codebooks }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  codebook
    .command('migrate')
    .description(
      'Assign codes that predate codebooks to the primary codebook (dry-run unless --apply)',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--apply', 'Emit the update events and rewrite frontmatter (default: preview)')
    .action((flags: MigrateFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        if (flags.apply !== true) {
          const plan = planCodebookMigration(seedPath)
          emit(
            {
              status: 'ok',
              command: 'codebook migrate',
              dry_run: true,
              needs_primary: plan.needs_primary,
              codes: plan.codes.map((c) => c.ref),
              file_only: plan.file_only,
            },
            out,
          )
          return
        }
        const result = applyCodebookMigration(seedPath, defaultResearcherId())
        emit(
          {
            status: 'ok',
            command: 'codebook migrate',
            dry_run: false,
            primary_created: result.primary_created,
            updated: result.updated,
            file_only_stamped: result.file_only_stamped,
          },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  // ADR 0001's full verb surface, visible but honest until they land.
  codebook
    .command('merge')
    .description(
      stubDescription('Merge one codebook into another (reject archives, never deletes)'),
    )
    .action(stubAction({ command: 'codebook merge' }))
  codebook
    .command('fork')
    .description(stubDescription('Fork a codebook into a new lens over the same seed'))
    .action(stubAction({ command: 'codebook fork' }))
  codebook
    .command('import')
    .description(stubDescription('Import a codebook from another seed as a shareable frame'))
    .action(stubAction({ command: 'codebook import' }))
}
