import { execFileSync } from 'node:child_process'
import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import {
  CODEBOOK_STANCES,
  type CodebookStance,
  createCodebook,
  DEFAULT_CODEBOOK_ID,
  defaultResearcherId,
} from '../lib/artifacts.js'
import {
  applyCodebookMigration,
  applyCodeIdMigration,
  duplicateCodebook,
  listCodebooks,
  planCodebookMigration,
  planCodeIdMigration,
} from '../lib/codebooks.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { stubAction, stubDescription } from './_stub.js'

/** Whether the git working tree containing `seedPath` has uncommitted changes;
 * null when `seedPath` isn't inside a git repo (no undo point to protect). */
function gitTreeDirty(seedPath: string): boolean | null {
  try {
    const out = execFileSync('git', ['-C', seedPath, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim().length > 0
  } catch {
    return null // not a git repo / git unavailable
  }
}

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

interface MigrateIdsFlags {
  seed?: string
  apply?: boolean
  force?: boolean
}

interface DuplicateFlags {
  seed?: string
  from?: string
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

  codebook
    .command('migrate-ids')
    .description(
      'Qualify legacy code ids to C-<codebook>/<code> + namespace their files (#269; dry-run unless --apply)',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--apply', 'Rewrite ids + move files + emit rename events (default: preview)')
    .option('--force', 'Apply even when the git working tree is dirty (skips the undo-point guard)')
    .addHelpText(
      'after',
      '\nUniform Option A (ADR 0001): every code gets a frame-qualified id. Existing bare `C-<slug>` refs keep resolving via the shorthand shim, so this is a normalization — run it when you want the namespaced form on disk. After applying, run `compost reindex --vectors` to refresh chunk code_ids.',
    )
    .action((flags: MigrateIdsFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        if (flags.apply !== true) {
          const plan = planCodeIdMigration(seedPath)
          emit(
            {
              status: 'ok',
              command: 'codebook migrate-ids',
              dry_run: true,
              already_qualified: plan.already_qualified,
              codes: plan.codes.map((c) => ({ from: c.old_id, to: c.new_id })),
              conflicts: plan.conflicts,
            },
            out,
            (d: { codes: unknown[]; already_qualified: number; conflicts: unknown[] }) =>
              `codebook migrate-ids (dry-run): ${d.codes.length} code(s) would be qualified, ${d.already_qualified} already namespaced${
                d.conflicts.length > 0 ? `, ${d.conflicts.length} CONFLICT(s) block --apply` : ''
              }. Re-run with --apply.`,
          )
          return
        }
        // Refuse to mutate files on a dirty tree (so `git restore` is an undo
        // point), unless the seed isn't under git or --force is given.
        if (flags.force !== true && gitTreeDirty(seedPath) === true) {
          throw new CompostError(
            'INVALID_INPUT',
            'Refusing --apply: the git working tree has uncommitted changes. Commit or stash first so you have an undo point, or pass --force.',
          )
        }
        const result = applyCodeIdMigration(seedPath, defaultResearcherId())
        emit(
          {
            status: 'ok',
            command: 'codebook migrate-ids',
            dry_run: false,
            migrated: result.migrated,
          },
          out,
          (d: { migrated: unknown[] }) =>
            `codebook migrate-ids: qualified ${d.migrated.length} code(s). Run \`compost reindex --vectors\` to refresh chunk code_ids.`,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  codebook
    .command('duplicate')
    .description(
      'Duplicate a codebook as a new independent lens — definitions + lineage travel; evidence re-grounds locally',
    )
    .argument('<source>', 'Source codebook to copy (name or CB- id)')
    .argument('<new-name>', 'Name for the new codebook (slugified for the CB- id)')
    .option(
      '--from <seed>',
      'Read <source> from a sibling seed under Seeds/ instead of this one (reuse a validated frame from another study)',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .addHelpText(
      'after',
      '\nDefinitions + a `derived_from` lineage link travel; coded instances (evidence) do NOT — the copy enters un-grounded and earns its grounding by being coded against the local data. Category links are not copied. (`import` is the NVivo/ATLAS.ti term for the cross-seed `--from` case.)\n\nExamples:\n  $ compost codebook duplicate epistemology epistemology-v2\n  $ compost codebook duplicate epistemology borrowed-frame --from prior-study',
    )
    .action((source: string, newName: string, flags: DuplicateFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const result = duplicateCodebook(seedPath, source, newName, defaultResearcherId(), {
          ...(flags.from !== undefined ? { fromSeed: flags.from } : {}),
        })
        emit(
          {
            status: 'ok',
            command: 'codebook duplicate',
            source_seed: result.source_seed,
            source: result.source_codebook_id,
            codebook: result.codebook_id,
            stance: result.stance,
            codes: result.codes.length,
            cloned: result.codes,
          },
          out,
          (d: { codebook: string; codes: number; source: string }) =>
            `codebook duplicate: created ${d.codebook} from ${d.source} with ${d.codes} un-grounded code(s). Code them against the local data to ground the lens.`,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  // ADR 0001's remaining verb, visible but honest until it lands (#269).
  codebook
    .command('merge')
    .description(
      stubDescription('Merge one codebook into another (reject archives, never deletes)', 269),
    )
    .action(stubAction({ command: 'codebook merge', issue: 269 }))
}
