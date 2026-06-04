import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Plugin version stamped into AI-authored artifacts' actor_id. */
export const PLUGIN_VERSION = '0.1.0'

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

/**
 * Actor id for an AI-authored artifact. The hash is over the tool-call args —
 * NOT the upstream LLM prompt, which the MCP layer can't observe. It still
 * uniquely fingerprints what was created and tags it as Claude-Code-authored.
 */
export function aiActorId(args: Record<string, unknown>): string {
  const sha = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 8)
  return `claude-code:${PLUGIN_VERSION}:${sha}`
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
      properties: { session: str('Session id, e.g. S001'), seed: str('Seed') },
    },
    toArgv: (a) => ['transcribe', String(a.session), ...(a.seed ? ['--seed', String(a.seed)] : [])],
  },
  {
    name: 'compost_export',
    description: 'Export a transcript.json to CSV or Markdown.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      required: ['transcript', 'format'],
      properties: { transcript: str('Path to transcript.json'), format: str('csv | md') },
    },
    toArgv: (a) => ['export', String(a.transcript), '--format', String(a.format)],
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
      properties: { session: str('Session id, e.g. S001'), seed: str('Seed') },
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
        seed: str('Seed'),
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
    name: 'compost_endorse',
    description:
      "Endorse an artifact — promotes an AI [draft] to researcher-approved. This is the RESEARCHER's act: the host shows a confirmation, and approving it IS the endorsement. Do not call autonomously to self-approve your own drafts.",
    readOnly: false,
    // Not aiAuthored: the endorse event's actor is the researcher (the human
    // who approves the mutation), not Claude Code.
    inputSchema: {
      type: 'object',
      required: ['artifact'],
      properties: {
        artifact: str('SHA256 prefix or latest:<kind>=<seed>'),
        researcher: str('Researcher identity (default $COMPOST_USER)'),
        seed: str('Seed'),
      },
    },
    toArgv: (a) => [
      'endorse',
      String(a.artifact),
      ...(a.researcher ? ['--researcher', String(a.researcher)] : []),
      ...(a.seed ? ['--seed', String(a.seed)] : []),
    ],
  },
]

export const READ_ONLY_TOOLS = TOOLS.filter((t) => t.readOnly).map((t) => t.name)
export const MUTATION_TOOLS = TOOLS.filter((t) => !t.readOnly).map((t) => t.name)

export type CliRunner = (argv: string[]) => Promise<{ stdout: string; code: number }>

const defaultRunner: CliRunner = async (argv) => {
  try {
    const { stdout } = await execFileAsync('compost', argv, { maxBuffer: 64 * 1024 * 1024 })
    return { stdout, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout || e.stderr || String(err), code: e.code ?? 1 }
  }
}

/** Build the argv for a tool, appending AI-authorship flags for aiAuthored
 * tools so the artifact lands as a Claude-Code [draft]. Exposed for tests. */
export function buildArgv(tool: ToolDef, args: Record<string, unknown>): string[] {
  const argv = tool.toArgv(args)
  if (tool.aiAuthored === true) {
    argv.push('--ai', '--actor-id', aiActorId(args))
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
  const { stdout, code } = await runner(buildArgv(tool, args))
  return { ok: code === 0, content: stdout.trim() }
}
