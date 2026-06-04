import type { Command } from 'commander'
import { CompostError, isCompostError } from '../errors.js'
import {
  type CreatedArtifact,
  createCode,
  createHighlight,
  createTheme,
  defaultResearcherId,
} from '../lib/artifacts.js'
import type { Author } from '../lib/events.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface CommonFlags {
  seed?: string
  ai?: boolean
  actorId?: string
  model?: string
  promptHash?: string
}

/**
 * Resolve the author from flags. Direct CLI use = researcher (a human ran it).
 * The MCP wrapper passes `--ai --actor-id claude-code:<ver>:<sha>` so the
 * artifact lands as an un-endorsed AI [draft].
 */
function resolveAuthor(flags: CommonFlags): Author {
  if (flags.ai === true) {
    if (flags.actorId === undefined) {
      throw new CompostError(
        'INVALID_INPUT',
        '--ai requires --actor-id (e.g. claude-code:0.1.0:abc12345)',
      )
    }
    return {
      actorType: 'ai',
      actorId: flags.actorId,
      ...(flags.model !== undefined ? { model: flags.model } : {}),
      ...(flags.promptHash !== undefined ? { promptHash: flags.promptHash } : {}),
    }
  }
  return { actorType: 'researcher', actorId: flags.actorId ?? defaultResearcherId() }
}

function emitCreated(kind: string, created: CreatedArtifact, cmd: Command): void {
  const out = getOutputOpts(cmd)
  emit(
    {
      status: 'ok',
      command: `create ${kind}`,
      id: created.id,
      artifact_id: created.artifact_id,
      path: created.path,
      event_id: created.event_id,
    },
    out,
  )
}

interface HighlightFlags extends CommonFlags {
  session: string
  utterance: string
  span: string
  text: string
}

interface CodeFlags extends CommonFlags {
  name: string
  definition: string
  evidence?: string
}

interface ThemeFlags extends CommonFlags {
  name: string
  summary: string
  codes?: string
}

function addAuthorFlags(c: Command): Command {
  return c
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--ai', 'Mark the artifact as AI-authored (lands as [draft] until endorsed)')
    .option('--actor-id <id>', 'Actor id (required with --ai; e.g. claude-code:0.1.0:abc12345)')
    .option('--model <model>', 'Model that produced the suggestion (with --ai)')
    .option('--prompt-hash <sha>', 'sha256(prompt+model+temp+ctx) (with --ai)')
}

export function registerCreate(program: Command): void {
  const create = program
    .command('create')
    .description('Create a highlight, code, or theme (writes markdown + emits a provenance event)')

  addAuthorFlags(
    create
      .command('highlight')
      .description('Create a highlight anchored to an utterance span')
      .requiredOption('--session <id>', 'Session id (e.g. S001)')
      .requiredOption('--utterance <id>', 'Utterance id (e.g. U-0002)')
      .requiredOption('--span <start,end>', 'Char span into the utterance text, e.g. 0,16')
      .requiredOption('--text <quote>', 'The highlighted verbatim text'),
  ).action((flags: HighlightFlags, cmd: Command) => {
    try {
      const seedPath = resolveSeedPath(process.cwd(), flags.seed)
      const span = parseSpan(flags.span)
      const created = createHighlight(seedPath, {
        sessionId: flags.session,
        utteranceId: flags.utterance,
        span,
        text: flags.text,
        author: resolveAuthor(flags),
      })
      emitCreated('highlight', created, cmd)
    } catch (err) {
      if (isCompostError(err)) emitError(err, getOutputOpts(cmd))
      throw err
    }
  })

  addAuthorFlags(
    create
      .command('code')
      .description('Create a code with a definition and optional evidence highlights')
      .requiredOption(
        '--name <name>',
        'Code name (slugified for the id, e.g. distrust-of-automation)',
      )
      .requiredOption('--definition <text>', 'What this code captures')
      .option('--evidence <ids>', 'Comma-separated highlight ids (e.g. H-001,H-002)'),
  ).action((flags: CodeFlags, cmd: Command) => {
    try {
      const seedPath = resolveSeedPath(process.cwd(), flags.seed)
      const created = createCode(seedPath, {
        name: flags.name,
        definition: flags.definition,
        evidence: parseList(flags.evidence),
        author: resolveAuthor(flags),
      })
      emitCreated('code', created, cmd)
    } catch (err) {
      if (isCompostError(err)) emitError(err, getOutputOpts(cmd))
      throw err
    }
  })

  addAuthorFlags(
    create
      .command('theme')
      .description('Create a theme grouping codes under a summary')
      .requiredOption('--name <name>', 'Theme name (slugified for the id)')
      .requiredOption('--summary <text>', 'The theme statement')
      .option('--codes <ids>', 'Comma-separated code ids (e.g. C-distrust,C-override)'),
  ).action((flags: ThemeFlags, cmd: Command) => {
    try {
      const seedPath = resolveSeedPath(process.cwd(), flags.seed)
      const created = createTheme(seedPath, {
        name: flags.name,
        summary: flags.summary,
        codes: parseList(flags.codes),
        author: resolveAuthor(flags),
      })
      emitCreated('theme', created, cmd)
    } catch (err) {
      if (isCompostError(err)) emitError(err, getOutputOpts(cmd))
      throw err
    }
  })
}

function parseSpan(s: string): [number, number] {
  const parts = s.split(',').map((p) => Number.parseInt(p.trim(), 10))
  if (parts.length !== 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new CompostError(
      'INVALID_INPUT',
      `--span must be "start,end" non-negative ints; got ${JSON.stringify(s)}`,
    )
  }
  return [parts[0] as number, parts[1] as number]
}

function parseList(s: string | undefined): string[] {
  if (s === undefined || s.trim() === '') return []
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}
