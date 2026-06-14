import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { citeMemo, createMemo, defaultResearcherId, editMemo } from '../lib/artifacts.js'
import {
  displayTitle,
  getMemo,
  listMemos,
  MEMO_ANCHOR_KINDS,
  type MemoAnchor,
  type MemoAnchorKind,
  type MemoType,
  type MemoView,
  memosAbout,
} from '../lib/memos.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { addAuthorFlags, type CommonFlags, loadInputs, resolveAuthor } from './create.js'

interface NewFlags extends CommonFlags {
  title?: string
  type?: string
  anchor?: string[]
  codebook?: string
  crossFrame?: boolean
}
interface ListFlags {
  seed?: string
  about?: string
  type?: string
  codebook?: string
  includeArchived?: boolean
}
interface ViewFlags {
  seed?: string
}
interface EditFlags {
  seed?: string
  content?: string
  type?: string
  title?: string
}

/** Shape a memo for output: the raw view plus the resolved display_title
 * (human → suggested → first-line). */
function withDisplay(m: MemoView): MemoView & { display_title: string } {
  return { ...m, display_title: displayTitle(m) }
}
interface CiteFlags {
  seed?: string
  anchor?: string[]
}

/** Collect a repeatable option into an array. */
function collect(value: string, acc: string[]): string[] {
  acc.push(value)
  return acc
}

/** Parse `--anchor kind:ref` tokens (e.g. `code:distrust`, `theme:T-x`,
 * `highlight:H-001`) into structured anchors, validating the kind (§10). */
function parseAnchors(tokens: string[] | undefined): MemoAnchor[] {
  if (tokens === undefined) return []
  return tokens.map((token) => {
    const idx = token.indexOf(':')
    if (idx === -1) {
      throw new CompostError(
        'INVALID_INPUT',
        `--anchor must be kind:ref (kind ∈ ${MEMO_ANCHOR_KINDS.join(' | ')}); got "${token}".`,
      )
    }
    const kind = token.slice(0, idx)
    const ref = token.slice(idx + 1)
    if (!MEMO_ANCHOR_KINDS.includes(kind as MemoAnchorKind)) {
      throw new CompostError(
        'INVALID_INPUT',
        `Anchor kind must be ${MEMO_ANCHOR_KINDS.join(' | ')}; got "${kind}" in "${token}".`,
      )
    }
    if (ref.length === 0) {
      throw new CompostError('INVALID_INPUT', `Anchor ref is empty in "${token}".`)
    }
    return { kind: kind as MemoAnchorKind, ref }
  })
}

export function registerMemo(program: Command): void {
  const memo = program
    .command('memo')
    .description(
      "Write and link analytic memos — the analyst's dated, evolving interpretive record (ADR 0004). Endorse/reject AI [draft] memos with the top-level `compost endorse|reject <M-id>`.",
    )

  addAuthorFlags(
    memo
      .command('new')
      .description(
        'Write a memo from a thought (researcher-authored; --ai lands it as a [draft] until endorsed). A title is optional — omit it to brain-dump; `memo list` falls back to the first line. The id is a stable M-NNN, never derived from the title.',
      )
      .argument('<content>', 'The memo body (the thought)')
      .option('--title <text>', 'Optional title for retrieval (else the first line is shown)')
      .option(
        '--type <type>',
        'Reflection type: code | category | theme | reflexive | method | theory | freeform (default: freeform)',
      )
      .option(
        '--anchor <kind:ref>',
        'What the memo is about (repeatable): code:distrust, theme:T-x, category:CAT-y, highlight:H-001, codebook:CB-z, memo:M-w',
        collect,
        [],
      )
      .option('--codebook <ref>', 'Scope the memo to one codebook frame (CB- id or name)')
      .option('--cross-frame', 'Mark a frame-less / project-level memo (codebook_id=null)'),
  ).action((content: string, flags: NewFlags, cmd: Command) => {
    const out = getOutputOpts(cmd)
    try {
      if (flags.crossFrame === true && flags.codebook !== undefined) {
        throw new CompostError(
          'INVALID_INPUT',
          '--cross-frame and --codebook are mutually exclusive.',
        )
      }
      const seedPath = resolveSeedPath(process.cwd(), flags.seed)
      const inputs = loadInputs(flags)
      // undefined = infer frame from anchors; null = project-level; CB-id = scoped.
      const codebookId: string | null | undefined =
        flags.crossFrame === true ? null : flags.codebook
      const created = createMemo(seedPath, {
        content,
        ...(flags.title !== undefined ? { title: flags.title } : {}),
        ...(flags.type !== undefined ? { type: flags.type as MemoType } : {}),
        anchors: parseAnchors(flags.anchor),
        ...(codebookId !== undefined ? { codebookId } : {}),
        author: resolveAuthor(flags),
        ...(inputs !== undefined ? { inputs } : {}),
      })
      emit(
        {
          status: 'ok',
          command: 'memo new',
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

  memo
    .command('list')
    .description("List the seed's memos (newest first); filter by --about / --type / --codebook")
    .option('--about <ref>', 'Only memos anchored to this artifact (e.g. C-distrust, T-x, H-001)')
    .option('--type <type>', 'Only memos of this reflection type')
    .option('--codebook <ref>', 'Only memos scoped to this frame (CB- id)')
    .option('--include-archived', 'Include rejected (archived) memos')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((flags: ListFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const opts = flags.includeArchived === true ? { includeArchived: true } : {}
        let memos =
          flags.about !== undefined
            ? memosAbout(seedPath, flags.about, opts)
            : listMemos(seedPath, opts)
        if (flags.type !== undefined) memos = memos.filter((m) => m.type === flags.type)
        if (flags.codebook !== undefined)
          memos = memos.filter((m) => m.codebookId === flags.codebook)
        emit(
          {
            status: 'ok',
            command: 'memo list',
            count: memos.length,
            memos: memos.map(withDisplay),
          },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  memo
    .command('view')
    .description('Print a single memo (current state from the ledger)')
    .argument('<ref>', 'Memo id (M-NNN) or SHA prefix')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((ref: string, flags: ViewFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const m = getMemo(seedPath, ref)
        if (m === null) throw new CompostError('FILE_NOT_FOUND', `No memo "${ref}" in this seed.`)
        emit({ status: 'ok', command: 'memo view', memo: withDisplay(m) }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  memo
    .command('edit')
    .description('Revise a memo (emits an update event; the ledger carries the evolution)')
    .argument('<ref>', 'Memo id (M-NNN) or SHA prefix')
    .option('--content <text>', 'New body text')
    .option('--title <text>', 'Set or change the title (the id stays the same)')
    .option('--type <type>', 'New reflection type')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((ref: string, flags: EditFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        if (flags.content === undefined && flags.type === undefined && flags.title === undefined) {
          throw new CompostError(
            'INVALID_INPUT',
            'Nothing to edit — pass --content, --title, and/or --type.',
          )
        }
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const result = editMemo(seedPath, ref, {
          ...(flags.content !== undefined ? { content: flags.content } : {}),
          ...(flags.title !== undefined ? { title: flags.title } : {}),
          ...(flags.type !== undefined ? { type: flags.type as MemoType } : {}),
          author: { actorType: 'researcher', actorId: defaultResearcherId() },
        })
        emit({ status: 'ok', command: 'memo edit', ...result }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  memo
    .command('cite')
    .description('Anchor a memo to more of the workflow (append anchors; idempotent)')
    .argument('<ref>', 'Memo id (M-NNN) or SHA prefix')
    .requiredOption(
      '--anchor <kind:ref>',
      'Anchor to add (repeatable): code:distrust, theme:T-x, highlight:H-001, …',
      collect,
      [],
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((ref: string, flags: CiteFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const add = parseAnchors(flags.anchor)
        if (add.length === 0) {
          throw new CompostError('INVALID_INPUT', 'Pass at least one --anchor kind:ref.')
        }
        const result = citeMemo(seedPath, ref, add, {
          actorType: 'researcher',
          actorId: defaultResearcherId(),
        })
        emit({ status: 'ok', command: 'memo cite', ...result }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
