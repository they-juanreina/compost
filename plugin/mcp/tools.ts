import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Roots an *agent-driven* ingest may read from (#236). An MCP agent is a
 * lower-trust caller than a human at a shell: combined with prompt-injection in
 * an already-ingested transcript, an unconstrained `compost_ingest` is a
 * self-directed exfiltration primitive (read planted instruction → ingest
 * ~/.ssh or a sibling repo → surface it via compost_search). So MCP ingest is
 * confined to the project working directory (where Seeds/ lives) by default;
 * `$COMPOST_INGEST_ROOTS` (colon-separated) adds more. The human CLI stays
 * fully permissive — this guard is the plugin layer only.
 */
export function ingestRoots(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string[] {
  const extra = (env.COMPOST_INGEST_ROOTS ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((p) => resolve(cwd, p))
  return [resolve(cwd), ...extra]
}

/** True when `rawPath` resolves inside one of the allowed ingest roots. The
 * per-root lexical check is the parallel of cli/src/lib/pathSafe.ts's
 * `isContainedUnder` — kept inline here because the plugin is a separate package
 * and this is its only use, but deliberately ALLOWS `target === root` (`rel ===
 * ''`), unlike the strict CLI twin. Keep the two in sync if the rule changes. */
export function isIngestPathAllowed(
  rawPath: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): boolean {
  const target = resolve(cwd, rawPath)
  return ingestRoots(env, cwd).some((root) => {
    const rel = relative(root, target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(`..${sep}`))
  })
}

/** Plugin version stamped into AI-authored artifacts' actor_id. */
export const PLUGIN_VERSION = '0.1.2'

export interface ToolDef {
  name: string
  description: string
  /** Read-only tools are safe to auto-approve; mutations need confirmation. */
  readOnly: boolean
  /** When true, the tool authors an artifact as AI: runTool appends
   * `--ai --actor-id claude-code:<ver>:<sha8(args)>` so it lands as a
   * `[draft]` until a researcher endorses. Endorsement itself is NOT
   * ai-authored — it's the researcher's act (the mutation-confirmation gate
   * the host shows the human is that approval). */
  aiAuthored?: boolean
  inputSchema: Record<string, unknown>
  /** Maps validated args → compost CLI argv (after the `compost` binary). */
  toArgv: (args: Record<string, unknown>) => string[]
}

const str = (desc: string) => ({ type: 'string', description: desc })

/** A session-id arg constrained at the schema boundary to a bare label, so a
 * host agent can't pass a path-traversal value (mirrors assertSessionId in the
 * CLI; the CLI re-validates regardless). */
const sessionArg = (desc: string) => ({
  type: 'string',
  description: desc,
  pattern: '^[A-Za-z0-9_-]+$',
})

/**
 * Provenance fingerprint for an AI-authored artifact: sha256 over the tool-call
 * args. It is NOT the upstream LLM prompt (the MCP layer can't observe that),
 * but it uniquely fingerprints what was created — the closest observable proxy.
 * Doubles as the `--prompt-hash` the events schema requires for actor_type=ai.
 */
export function argsPromptHash(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex')
}

/** Actor id for an AI-authored artifact: `claude-code:<ver>:<sha8(args)>`. */
export function aiActorId(args: Record<string, unknown>): string {
  return `claude-code:${PLUGIN_VERSION}:${argsPromptHash(args).slice(0, 8)}`
}

/** Model recorded for an AI-authored event. Claude knows its own id and may
 * pass it as the `model` arg; absent that, fall back to the authoring agent. */
function aiModel(args: Record<string, unknown>): string {
  return typeof args.model === 'string' && args.model.trim() !== '' ? args.model : 'claude-code'
}

/**
 * MCP tools mirror the CLI subcommand contracts and execute the same `compost`
 * binary — no logic is duplicated. Read-only vs mutation is declared per tool.
 */
export const TOOLS: ToolDef[] = [
  {
    name: 'compost_status',
    description: 'Kind-grouped counts for a seed (sessions, highlights, codes, themes, frames).',
    readOnly: true,
    inputSchema: { type: 'object', properties: { seed: str('Seed name (optional)') } },
    toArgv: (a) => ['status', ...(a.seed ? ['--seed', String(a.seed)] : [])],
  },
  {
    name: 'compost_blame',
    description:
      'Print the three-actor lineage chain for an artifact id (or latest:<kind>=<seed>).',
    readOnly: true,
    inputSchema: {
      type: 'object',
      required: ['artifact'],
      properties: { artifact: str('SHA256 prefix or latest:<kind>=<seed>'), seed: str('Seed') },
    },
    toArgv: (a) => ['blame', String(a.artifact), ...(a.seed ? ['--seed', String(a.seed)] : [])],
  },
  {
    name: 'compost_agreement',
    description:
      "Human↔machine intercoder agreement (Cohen's κ + Krippendorff's α) over highlights coded by BOTH a blind researcher and the machine, WITHIN one codebook (κ is undefined across frames; defaults to primary). Read-only. Reports `insufficient` below the minimum sample. NOTE: the human side comes from `compost recode`, which is intentionally NOT an agent tool — only a researcher codes blind.",
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        seed: str('Seed'),
        min_units: {
          type: 'number',
          description: 'Minimum doubly-coded units for a meaningful κ (default 10)',
        },
        codebook: str('Codebook (frame) to measure within (name or CB- id; default: primary)'),
      },
    },
    toArgv: (a) => [
      'agreement',
      ...(a.seed ? ['--seed', String(a.seed)] : []),
      ...(a.min_units ? ['--min-units', String(a.min_units)] : []),
      ...(a.codebook ? ['--codebook', String(a.codebook)] : []),
    ],
  },
  {
    name: 'compost_ingest',
    description:
      'Route a file or folder into the seed job queue (audio/video/PDF/DOCX/PPTX/CSV/MD).',
    readOnly: false,
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: str('File or folder'), seed: str('Seed') },
    },
    toArgv: (a) => ['ingest', String(a.path), ...(a.seed ? ['--seed', String(a.seed)] : [])],
  },
  {
    name: 'compost_transcribe',
    description: 'Transcribe a session synchronously via the transcriber service.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      required: ['session'],
      properties: { session: sessionArg('Session id, e.g. S001'), seed: str('Seed') },
    },
    toArgv: (a) => ['transcribe', String(a.session), ...(a.seed ? ['--seed', String(a.seed)] : [])],
  },
  {
    name: 'compost_export',
    description:
      "Export a transcript.json (csv | md | eaf) or a seed's provenance event log to W3C PROV-O JSON-LD (prov).",
    readOnly: true,
    inputSchema: {
      type: 'object',
      required: ['format'],
      properties: {
        transcript: str('Path to transcript.json (required for csv | md | eaf)'),
        format: str('csv | md | eaf | prov'),
        seed: str('Seed (for prov)'),
      },
    },
    toArgv: (a) => [
      'export',
      ...(a.transcript ? [String(a.transcript)] : []),
      '--format',
      String(a.format),
      ...(a.seed ? ['--seed', String(a.seed)] : []),
    ],
  },
  {
    name: 'compost_models_doctor',
    description: 'Probe configured LLM providers and report per-task routing health.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { seed: str('Seed') } },
    toArgv: (a) => ['models', 'doctor', ...(a.seed ? ['--seed', String(a.seed)] : [])],
  },
  {
    name: 'compost_search',
    description:
      'Retrieve ranked passages from the seed corpus (BM25; no LLM). Use this to ground answers in real utterances before reasoning — each result carries session, time range, and text.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: str('Free-text query'),
        seed: str('Seed'),
        top_k: { type: 'number', description: 'Number of passages to return (default 8)' },
      },
    },
    toArgv: (a) => [
      'search',
      String(a.query),
      ...(a.seed ? ['--seed', String(a.seed)] : []),
      ...(a.top_k ? ['--top-k', String(a.top_k)] : []),
    ],
  },
  {
    name: 'compost_get_session',
    description:
      "Read a session's full transcript (utterances, silences, cues, frames) as JSON. Use after compost_search to pull a whole session into context.",
    readOnly: true,
    inputSchema: {
      type: 'object',
      required: ['session'],
      properties: { session: sessionArg('Session id, e.g. S001'), seed: str('Seed') },
    },
    toArgv: (a) => ['session', String(a.session), ...(a.seed ? ['--seed', String(a.seed)] : [])],
  },
  {
    name: 'compost_create_highlight',
    description:
      'Create a highlight anchored to an utterance span. Lands as an AI [draft] until a researcher endorses it.',
    readOnly: false,
    aiAuthored: true,
    inputSchema: {
      type: 'object',
      required: ['session', 'utterance', 'span', 'text'],
      properties: {
        session: str('Session id, e.g. S001'),
        utterance: str('Utterance id, e.g. U-0002'),
        span: str('Char span "start,end" into the utterance text, e.g. 0,16'),
        text: str('The highlighted verbatim text'),
        seed: str('Seed'),
        model: str('Your model id for provenance (e.g. claude-opus-4-8); defaults to claude-code'),
      },
    },
    toArgv: (a) => [
      'create',
      'highlight',
      '--session',
      String(a.session),
      '--utterance',
      String(a.utterance),
      '--span',
      String(a.span),
      '--text',
      String(a.text),
      ...(a.seed ? ['--seed', String(a.seed)] : []),
    ],
  },
  {
    name: 'compost_create_code',
    description:
      'Create a code with a definition and optional evidence highlights. Lands as an AI [draft] until endorsed.',
    readOnly: false,
    aiAuthored: true,
    inputSchema: {
      type: 'object',
      required: ['name', 'definition'],
      properties: {
        name: str('Code name (slugified for the id, e.g. distrust-of-automation)'),
        definition: str('What this code captures'),
        evidence: str('Comma-separated highlight ids, e.g. H-001,H-002'),
        codebook: str('Codebook this code belongs to (name or CB- id; default: primary)'),
        seed: str('Seed'),
        model: str('Your model id for provenance (e.g. claude-opus-4-8); defaults to claude-code'),
      },
    },
    toArgv: (a) => [
      'create',
      'code',
      '--name',
      String(a.name),
      '--definition',
      String(a.definition),
      ...(a.evidence ? ['--evidence', String(a.evidence)] : []),
      ...(a.codebook ? ['--codebook', String(a.codebook)] : []),
      ...(a.seed ? ['--seed', String(a.seed)] : []),
    ],
  },
  {
    name: 'compost_create_theme',
    description:
      'Create a theme grouping codes under a summary. Lands as an AI [draft] until endorsed.',
    readOnly: false,
    aiAuthored: true,
    inputSchema: {
      type: 'object',
      required: ['name', 'summary'],
      properties: {
        name: str('Theme name (slugified for the id)'),
        summary: str('The theme statement'),
        codes: str('Comma-separated code ids, e.g. C-distrust,C-override'),
        seed: str('Seed'),
        model: str('Your model id for provenance (e.g. claude-opus-4-8); defaults to claude-code'),
      },
    },
    toArgv: (a) => [
      'create',
      'theme',
      '--name',
      String(a.name),
      '--summary',
      String(a.summary),
      ...(a.codes ? ['--codes', String(a.codes)] : []),
      ...(a.seed ? ['--seed', String(a.seed)] : []),
    ],
  },
  {
    name: 'compost_create_memo',
    description:
      "Write an analytic memo — your dated interpretive note about the corpus, a code, or a theme (the reasoning behind a move, a reflexive observation, a pattern hunch). Anchor it to what it's about. Always provide a concise, evocative, retrieval-friendly `title` you generate from the content (the human may have only given you a raw thought). Lands as an AI [draft] until a researcher endorses (compost endorse) — propose, never self-approve.",
    readOnly: false,
    aiAuthored: true,
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: str('The memo body — the reflection/reasoning'),
        title: str(
          'A short retrieval-friendly title. Optional in the CLI, but you should generate one from the content for scannability (the human edits it on endorse if needed).',
        ),
        type: {
          type: 'string',
          enum: ['code', 'category', 'theme', 'reflexive', 'method', 'theory', 'freeform'],
          description: 'Reflection type (default: freeform)',
        },
        anchor: {
          type: 'array',
          items: str('kind:ref — e.g. code:distrust, theme:T-x, category:CAT-y, highlight:H-001'),
          description: 'What the memo is about (repeatable anchors)',
        },
        codebook: str('Scope the memo to one codebook frame (CB- id or name)'),
        seed: str('Seed'),
        model: str('Your model id for provenance (e.g. claude-opus-4-8); defaults to claude-code'),
      },
    },
    toArgv: (a) => [
      'memo',
      'new',
      String(a.content),
      ...(a.title ? ['--title', String(a.title)] : []),
      ...(a.type ? ['--type', String(a.type)] : []),
      ...(Array.isArray(a.anchor) ? a.anchor.flatMap((x) => ['--anchor', String(x)]) : []),
      ...(a.codebook ? ['--codebook', String(a.codebook)] : []),
      ...(a.seed ? ['--seed', String(a.seed)] : []),
    ],
  },
  {
    name: 'compost_list_memos',
    description:
      "List analytic memos (newest first). Filter by `about` (memos anchored to an artifact — read the analyst's notes on a code/theme before acting), `type`, or `codebook`.",
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        about: str('Only memos anchored to this artifact (e.g. C-distrust, T-x, H-001)'),
        type: str('Only memos of this reflection type'),
        codebook: str('Only memos scoped to this frame (CB- id)'),
        seed: str('Seed'),
      },
    },
    toArgv: (a) => [
      'memo',
      'list',
      ...(a.about ? ['--about', String(a.about)] : []),
      ...(a.type ? ['--type', String(a.type)] : []),
      ...(a.codebook ? ['--codebook', String(a.codebook)] : []),
      ...(a.seed ? ['--seed', String(a.seed)] : []),
    ],
  },
  {
    name: 'compost_endorse',
    description:
      "Endorse an artifact — promotes an AI [draft] to researcher-approved. This is the RESEARCHER's act: the host shows a confirmation, and approving it IS the endorsement. Do not call autonomously to self-approve your own drafts.",
    readOnly: false,
    // Not aiAuthored: the endorse event's actor is the researcher (the human
    // who approves the mutation), not Claude Code. The endorsing IDENTITY is
    // bound server-side to $COMPOST_USER (the CLI default) — deliberately NOT a
    // tool arg, so an agent can't endorse under an arbitrary/author identity and
    // the CLI's self-endorse refusal can't be sidestepped (#236).
    inputSchema: {
      type: 'object',
      required: ['artifact'],
      properties: {
        artifact: str('SHA256 prefix or latest:<kind>=<seed>'),
        seed: str('Seed'),
      },
    },
    toArgv: (a) => ['endorse', String(a.artifact), ...(a.seed ? ['--seed', String(a.seed)] : [])],
  },
  {
    name: 'compost_rerun',
    description:
      'Rerun an AI/agent generation from its captured inputs. Default verifies the inputs are intact and reconstructable; with apply=true, regenerates a deterministic agent artifact and emits a chained diff. LLM regeneration is not wired yet.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      required: ['ref'],
      properties: {
        ref: str('Event ULID, artifact id/prefix, human id (C-/H-/T-), or latest:<kind>=<seed>'),
        apply: {
          type: 'boolean',
          description: 'Regenerate and emit a chained event (default false)',
        },
        model: str('Override the model for regeneration'),
        seed: str('Seed'),
      },
    },
    toArgv: (a) => [
      'rerun',
      String(a.ref),
      ...(a.apply === true ? ['--apply'] : []),
      ...(a.model ? ['--model', String(a.model)] : []),
      ...(a.seed ? ['--seed', String(a.seed)] : []),
    ],
  },
  {
    name: 'compost_code_suggest',
    description:
      'Cluster un-coded highlights in embedding space and preview candidate codes (no writes). Use to discover what codes the corpus suggests.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        seed: str('Seed'),
        threshold: { type: 'number', description: 'Cosine clustering threshold (default 0.75)' },
      },
    },
    toArgv: (a) => [
      'code',
      ...(a.seed ? ['--seed', String(a.seed)] : []),
      ...(a.threshold ? ['--threshold', String(a.threshold)] : []),
    ],
  },
  {
    name: 'compost_code_apply',
    description:
      'Persist the clustered code suggestions as AI [draft] code events. Mutation; the drafts await researcher endorsement.',
    readOnly: false,
    // The cluster-suggest path already stamps actor_type=agent on its events
    // (similarity-scanner@ver), so we do NOT add --ai here — authorship is the
    // scanner agent, distinct from a Claude-Code create_code.
    inputSchema: {
      type: 'object',
      properties: {
        seed: str('Seed'),
        threshold: { type: 'number', description: 'Cosine clustering threshold (default 0.75)' },
      },
    },
    toArgv: (a) => [
      'code',
      '--apply',
      ...(a.seed ? ['--seed', String(a.seed)] : []),
      ...(a.threshold ? ['--threshold', String(a.threshold)] : []),
    ],
  },
  {
    name: 'compost_codebook_new',
    description:
      'Create a codebook — an interpretive lens codes belong to (ADR 0001) — with a declared stance. A seed can hold several coexisting lenses over one corpus; codes are scoped to one. Researcher-authored (structural setup), not an AI [draft].',
    readOnly: false,
    // Not aiAuthored: `compost codebook new` authors as the researcher (a lens is
    // structural setup, not an interpretive suggestion) and the CLI verb has no
    // --ai path. Identity is the CLI default ($COMPOST_USER), as for endorse.
    inputSchema: {
      type: 'object',
      required: ['name', 'stance'],
      properties: {
        name: str('Codebook name (slugified for the CB- id, e.g. epistemology)'),
        stance: {
          type: 'string',
          enum: ['inductive', 'deductive', 'in_vivo', 'framework'],
          description: 'Declared interpretive standpoint of this lens',
        },
        description: str('What this lens is for'),
        seed: str('Seed'),
      },
    },
    toArgv: (a) => [
      'codebook',
      'new',
      String(a.name),
      '--stance',
      String(a.stance),
      ...(a.description ? ['--description', String(a.description)] : []),
      ...(a.seed ? ['--seed', String(a.seed)] : []),
    ],
  },
  {
    name: 'compost_codebook_list',
    description:
      "List the seed's codebooks (lenses) with their stance — the implicit `primary` plus any created lenses.",
    readOnly: true,
    inputSchema: { type: 'object', properties: { seed: str('Seed') } },
    toArgv: (a) => ['codebook', 'list', ...(a.seed ? ['--seed', String(a.seed)] : [])],
  },
  {
    name: 'compost_codebook_migrate',
    description:
      'Assign codes that predate codebooks to the primary codebook. Dry-run by default (previews the affected codes); set apply=true to emit the update events and stamp frontmatter.',
    readOnly: false,
    // Not aiAuthored: migrate stamps researcher update events (a maintenance op),
    // and the CLI verb has no --ai path.
    inputSchema: {
      type: 'object',
      properties: {
        seed: str('Seed'),
        apply: {
          type: 'boolean',
          description: 'Apply the migration (default false = dry-run preview)',
        },
      },
    },
    toArgv: (a) => [
      'codebook',
      'migrate',
      ...(a.seed ? ['--seed', String(a.seed)] : []),
      ...(a.apply === true ? ['--apply'] : []),
    ],
  },
  {
    name: 'compost_codebook_duplicate',
    description:
      'Duplicate a codebook as a new independent lens (ADR 0001, #269). Definitions + a `derived_from` lineage link travel; coded instances (evidence) do NOT — the copy enters un-grounded and earns its grounding by being coded against the local data (framework/deductive coding). Use `from` to reuse a validated frame from another study (the NVivo/ATLAS.ti "import" case). Refuses an in_vivo source. Researcher-authored (structural setup), not an AI [draft].',
    readOnly: false,
    // Not aiAuthored: duplicating a lens is structural setup the researcher
    // chooses (like `codebook new`); the CLI verb has no --ai path.
    inputSchema: {
      type: 'object',
      required: ['source', 'newName'],
      properties: {
        source: str('Source codebook to copy (name or CB- id)'),
        newName: str('Name for the new codebook (slugified for the CB- id)'),
        from: str(
          'Read source from a sibling seed under Seeds/ instead of this one (cross-study frame reuse)',
        ),
        seed: str('Seed'),
      },
    },
    toArgv: (a) => [
      'codebook',
      'duplicate',
      String(a.source),
      String(a.newName),
      ...(a.from ? ['--from', String(a.from)] : []),
      ...(a.seed ? ['--seed', String(a.seed)] : []),
    ],
  },
  {
    name: 'compost_codebook_merge',
    description:
      'Merge one codebook into another (ADR 0001, #269). Re-homes the source frame’s codes into the target (an update, not a copy — identity + evidence + history preserved), then reject-archives the source (never deletes). Colliding code names are kept distinct (`distrust` → `distrust-from-<frame>`), never silently fused — de-dup is a separate explicit step. Dry-run by default (previews the re-home + any blocking refs); set apply=true to write. Refuses when a re-homing code is cited by a theme or category link — resolve those first. Researcher-authored, not an AI [draft].',
    readOnly: false,
    // Not aiAuthored: a structural fold the researcher decides; no --ai path.
    inputSchema: {
      type: 'object',
      required: ['from', 'into'],
      properties: {
        from: str('Codebook to fold in (name or CB- id) — reject-archived after'),
        into: str('Codebook to merge into (name or CB- id)'),
        apply: {
          type: 'boolean',
          description: 'Re-home + archive (default false = dry-run preview)',
        },
        seed: str('Seed'),
      },
    },
    toArgv: (a) => [
      'codebook',
      'merge',
      String(a.from),
      String(a.into),
      ...(a.apply === true ? ['--apply'] : []),
      ...(a.seed ? ['--seed', String(a.seed)] : []),
    ],
  },
]

export const READ_ONLY_TOOLS = TOOLS.filter((t) => t.readOnly).map((t) => t.name)
export const MUTATION_TOOLS = TOOLS.filter((t) => !t.readOnly).map((t) => t.name)

export type CliRunner = (argv: string[]) => Promise<{ stdout: string; code: number }>

/**
 * Resolve how to invoke the compost CLI. The plugin does NOT bundle the CLI
 * (its native deps — better-sqlite3, lancedb — must install per-platform on
 * the user's machine), so the CLI is a prerequisite. Resolution order:
 *
 *   1. COMPOST_CLI env var — an explicit path. If it ends in .js we run it
 *      with `node`; otherwise it's treated as an executable.
 *   2. `compost` on PATH — from `npm i -g @they-juanreina/compost-cli` or a pnpm link.
 *
 * Returns the spawn command + any prefix args (e.g. the .js path for node).
 */
export function resolveCompostInvocation(env: NodeJS.ProcessEnv = process.env): {
  command: string
  prefixArgs: string[]
} {
  const override = env.COMPOST_CLI
  if (override !== undefined && override.trim() !== '') {
    return override.endsWith('.js')
      ? { command: process.execPath, prefixArgs: [override] }
      : { command: override, prefixArgs: [] }
  }
  return { command: 'compost', prefixArgs: [] }
}

const CLI_MISSING_HINT =
  'compost CLI not found. Install it (`npm i -g @they-juanreina/compost-cli`, or clone the repo and `pnpm build`), ' +
  'or set COMPOST_CLI to the path of dist/index.js. See docs/install.md.'

const defaultRunner: CliRunner = async (argv) => {
  const { command, prefixArgs } = resolveCompostInvocation()
  try {
    const { stdout } = await execFileAsync(command, [...prefixArgs, ...argv], {
      maxBuffer: 64 * 1024 * 1024,
    })
    return { stdout, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: string | number }
    // ENOENT = the CLI binary/path wasn't found → actionable install hint.
    if (e.code === 'ENOENT') {
      return {
        stdout: JSON.stringify({ error: { code: 'CLI_NOT_FOUND', message: CLI_MISSING_HINT } }),
        code: 1,
      }
    }
    return {
      stdout: e.stdout || e.stderr || String(err),
      code: typeof e.code === 'number' ? e.code : 1,
    }
  }
}

/** Build the argv for a tool, appending AI-authorship flags for aiAuthored
 * tools so the artifact lands as a Claude-Code [draft]. Exposed for tests. */
export function buildArgv(tool: ToolDef, args: Record<string, unknown>): string[] {
  const argv = tool.toArgv(args)
  if (tool.aiAuthored === true) {
    // AI-authored events require actor_id + model + prompt_hash (events schema).
    // Supply all three so the create lands as a [draft] instead of failing
    // validation and orphaning the markdown (#165).
    argv.push(
      '--ai',
      '--actor-id',
      aiActorId(args),
      '--model',
      aiModel(args),
      '--prompt-hash',
      argsPromptHash(args),
    )
  }
  return argv
}

/** Execute a tool by name with args, returning the CLI's JSON text result. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  runner: CliRunner = defaultRunner,
): Promise<{ ok: boolean; content: string }> {
  const tool = TOOLS.find((t) => t.name === name)
  if (tool === undefined) return { ok: false, content: `unknown tool: ${name}` }
  // Confine agent-driven ingest to the workspace (the human CLI stays permissive).
  if (name === 'compost_ingest' && !isIngestPathAllowed(String(args.path ?? ''))) {
    return {
      ok: false,
      content: JSON.stringify({
        error: {
          code: 'INGEST_PATH_DENIED',
          message: `ingest path "${String(args.path ?? '')}" is outside the allowed roots (the project directory; extend with COMPOST_INGEST_ROOTS). Move the file into the workspace, or run \`compost ingest\` from a shell.`,
        },
      }),
    }
  }
  const { stdout, code } = await runner(buildArgv(tool, args))
  return { ok: code === 0, content: stdout.trim() }
}
