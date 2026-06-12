import { existsSync, readFileSync } from 'node:fs'
import type { Command } from 'commander'
import { CompostError, isCompostError } from '../errors.js'
import {
  type CreatedArtifact,
  createCode,
  createHighlight,
  createTheme,
  defaultResearcherId,
} from '../lib/artifacts.js'
import type { AiInputBundle, Author } from '../lib/events.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import type { ThemeEvidence, ThemeEvidenceKind } from '../lib/themes.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface CommonFlags {
  seed?: string
  ai?: boolean
  actorId?: string
  model?: string
  promptHash?: string
  inputsFile?: string
}

/**
 * Best-effort capture of a host-agent generation's inputs. compost never sees the
 * prompt the host LLM built — only the prompt_hash — so `--inputs-file` lets the
 * MCP wrapper (or a researcher) hand over the bundle that backs `compost rerun`
 * and PROV-O. Only meaningful with `--ai`; absent → hash-only, as before.
 */
function loadInputs(flags: CommonFlags): AiInputBundle | undefined {
  if (flags.inputsFile === undefined) return undefined
  if (flags.ai !== true) {
    throw new CompostError('INVALID_INPUT', '--inputs-file only applies to AI creates (use --ai)')
  }
  if (!existsSync(flags.inputsFile)) {
    throw new CompostError('FILE_NOT_FOUND', `No inputs file at ${flags.inputsFile}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(flags.inputsFile, 'utf8'))
  } catch (cause) {
    throw new CompostError('INVALID_INPUT', `Could not parse inputs JSON at ${flags.inputsFile}`, {
      cause,
    })
  }
  const b = parsed as Partial<AiInputBundle>
  if (typeof b.model !== 'string' || typeof b.prompt !== 'string') {
    throw new CompostError(
      'SCHEMA_VIOLATION',
      `${flags.inputsFile} must be an input bundle with at least string "model" and "prompt"`,
    )
  }
  return parsed as AiInputBundle
}

/**
 * Resolve the author from flags. Direct CLI use = researcher (a human ran it).
 * The MCP wrapper passes `--ai --actor-id claude-code:<ver>:<sha>` so the
 * artifact lands as an un-endorsed AI [draft]. Exported for tests — it is the
 * fail-fast gate that keeps a missing --model/--prompt-hash from orphaning a
 * .md (#165).
 */
export function resolveAuthor(flags: CommonFlags): Author {
  if (flags.ai === true) {
    // AI-authored events MUST record actor_id, model, and a prompt_hash (the
    // events schema requires model + prompt_hash for actor_type=ai). Validate
    // up front and name the missing flag — the create funcs write the markdown,
    // so a late schema failure would orphan a .md with no event (#165).
    const missing: string[] = []
    if (flags.actorId === undefined) missing.push('--actor-id')
    if (flags.model === undefined) missing.push('--model')
    if (flags.promptHash === undefined) missing.push('--prompt-hash')
    if (missing.length > 0) {
      throw new CompostError(
        'INVALID_INPUT',
        `--ai requires ${missing.join(', ')} (AI-authored artifacts record the actor, model, and prompt hash for provenance; e.g. --actor-id claude-code:0.1.0:abc12345)`,
      )
    }
    if (!/^[a-f0-9]{64}$/.test(flags.promptHash as string)) {
      throw new CompostError(
        'INVALID_INPUT',
        `--prompt-hash must be a 64-char sha256 hex (sha256 of prompt+model+temp+ctx); got ${JSON.stringify(flags.promptHash)}`,
      )
    }
    return {
      actorType: 'ai',
      actorId: flags.actorId as string,
      model: flags.model as string,
      promptHash: flags.promptHash as string,
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
  codebook?: string
}

interface ThemeFlags extends CommonFlags {
  name: string
  summary: string
  codes?: string
  evidence?: string
  codebook?: string
  crossLens?: boolean
}

function addAuthorFlags(c: Command): Command {
  return c
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--ai', 'Mark the artifact as AI-authored (lands as [draft] until endorsed)')
    .option('--actor-id <id>', 'Actor id (required with --ai; e.g. claude-code:0.1.0:abc12345)')
    .option('--model <model>', 'Model that produced the suggestion (required with --ai)')
    .option(
      '--prompt-hash <sha>',
      'sha256(prompt+model+temp+ctx), 64-char hex (required with --ai)',
    )
    .option(
      '--inputs-file <path>',
      'JSON input bundle (model, params, system_prompt, prompt, context) to persist for rerun/PROV-O (optional, --ai only)',
    )
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
      const inputs = loadInputs(flags)
      const created = createHighlight(seedPath, {
        sessionId: flags.session,
        utteranceId: flags.utterance,
        span,
        text: flags.text,
        author: resolveAuthor(flags),
        ...(inputs !== undefined ? { inputs } : {}),
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
      .option('--evidence <ids>', 'Comma-separated highlight ids (e.g. H-001,H-002)')
      .option(
        '--codebook <ref>',
        'Codebook this code belongs to (name or CB- id; default: primary)',
      ),
  ).action((flags: CodeFlags, cmd: Command) => {
    try {
      const seedPath = resolveSeedPath(process.cwd(), flags.seed)
      const inputs = loadInputs(flags)
      const created = createCode(seedPath, {
        name: flags.name,
        definition: flags.definition,
        evidence: parseList(flags.evidence),
        ...(flags.codebook !== undefined ? { codebookId: flags.codebook } : {}),
        author: resolveAuthor(flags),
        ...(inputs !== undefined ? { inputs } : {}),
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
      .description('Create a theme over a heterogeneous {code|category} evidence set')
      .requiredOption('--name <name>', 'Theme name (slugified for the id)')
      .requiredOption('--summary <text>', 'The theme statement')
      .option('--codes <ids>', 'Comma-separated code ids (shorthand for code evidence)')
      .option(
        '--evidence <refs>',
        'Comma-separated kind:ref evidence (e.g. code:C-distrust,category:CAT-trust)',
      )
      .option('--codebook <ref>', 'Scope the theme to one codebook frame (CB- id or name)')
      .option('--cross-lens', 'Mark a cross-lens theme spanning ≥2 codebooks (codebook_id=null)')
      .addHelpText(
        'after',
        '\nA theme is single-lens by default (inferred from its evidence frames). Pass --cross-lens for a theme that cites evidence from two or more codebooks; it must reference ≥2 distinct frames (ADR 0002 §1).',
      ),
  ).action((flags: ThemeFlags, cmd: Command) => {
    try {
      if (flags.crossLens === true && flags.codebook !== undefined) {
        throw new CompostError(
          'INVALID_INPUT',
          '--cross-lens and --codebook are mutually exclusive.',
        )
      }
      const seedPath = resolveSeedPath(process.cwd(), flags.seed)
      const inputs = loadInputs(flags)
      const evidence =
        flags.evidence !== undefined
          ? parseEvidence(flags.evidence)
          : parseList(flags.codes).map((ref) => ({ kind: 'code' as const, ref }))
      // undefined = infer frame; null = cross-lens; CB-id = scoped.
      const codebookId: string | null | undefined = flags.crossLens === true ? null : flags.codebook
      const created = createTheme(seedPath, {
        name: flags.name,
        summary: flags.summary,
        evidence,
        ...(codebookId !== undefined ? { codebookId } : {}),
        author: resolveAuthor(flags),
        ...(inputs !== undefined ? { inputs } : {}),
      })
      emitCreated('theme', created, cmd)
    } catch (err) {
      if (isCompostError(err)) emitError(err, getOutputOpts(cmd))
      throw err
    }
  })
}

const EVIDENCE_KINDS: readonly ThemeEvidenceKind[] = ['code', 'category']

/** Parse `--evidence code:C-foo,category:CAT-bar` into structured refs. A bare
 * token (no `kind:` prefix) defaults to a code, so `--evidence C-foo` works. */
function parseEvidence(s: string): ThemeEvidence[] {
  return parseList(s).map((token) => {
    const idx = token.indexOf(':')
    if (idx === -1) return { kind: 'code', ref: token }
    const kind = token.slice(0, idx)
    const ref = token.slice(idx + 1)
    if (!EVIDENCE_KINDS.includes(kind as ThemeEvidenceKind)) {
      throw new CompostError(
        'INVALID_INPUT',
        `Evidence kind must be ${EVIDENCE_KINDS.join(' | ')}; got "${kind}" in "${token}".`,
      )
    }
    if (ref.length === 0) {
      throw new CompostError('INVALID_INPUT', `Evidence ref is empty in "${token}".`)
    }
    return { kind: kind as ThemeEvidenceKind, ref }
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
