import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ToolDef {
  name: string
  description: string
  /** Read-only tools are safe to auto-approve; mutations need confirmation. */
  readOnly: boolean
  inputSchema: Record<string, unknown>
  /** Maps validated args → compost CLI argv (after the `compost` binary). */
  toArgv: (args: Record<string, unknown>) => string[]
}

const str = (desc: string) => ({ type: 'string', description: desc })

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

/** Execute a tool by name with args, returning the CLI's JSON text result. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  runner: CliRunner = defaultRunner,
): Promise<{ ok: boolean; content: string }> {
  const tool = TOOLS.find((t) => t.name === name)
  if (tool === undefined) return { ok: false, content: `unknown tool: ${name}` }
  const { stdout, code } = await runner(tool.toArgv(args))
  return { ok: code === 0, content: stdout.trim() }
}
