import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
/** Plugin version stamped into AI-authored artifacts' actor_id. */
export const PLUGIN_VERSION = '0.1.2';
const str = (desc) => ({ type: 'string', description: desc });
/**
 * Provenance fingerprint for an AI-authored artifact: sha256 over the tool-call
 * args. It is NOT the upstream LLM prompt (the MCP layer can't observe that),
 * but it uniquely fingerprints what was created — the closest observable proxy.
 * Doubles as the `--prompt-hash` the events schema requires for actor_type=ai.
 */
export function argsPromptHash(args) {
    return createHash('sha256').update(JSON.stringify(args)).digest('hex');
}
/** Actor id for an AI-authored artifact: `claude-code:<ver>:<sha8(args)>`. */
export function aiActorId(args) {
    return `claude-code:${PLUGIN_VERSION}:${argsPromptHash(args).slice(0, 8)}`;
}
/** Model recorded for an AI-authored event. Claude knows its own id and may
 * pass it as the `model` arg; absent that, fall back to the authoring agent. */
function aiModel(args) {
    return typeof args.model === 'string' && args.model.trim() !== '' ? args.model : 'claude-code';
}
/**
 * MCP tools mirror the CLI subcommand contracts and execute the same `compost`
 * binary — no logic is duplicated. Read-only vs mutation is declared per tool.
 */
export const TOOLS = [
    {
        name: 'compost_status',
        description: 'Kind-grouped counts for a seed (sessions, highlights, codes, themes, frames).',
        readOnly: true,
        inputSchema: { type: 'object', properties: { seed: str('Seed name (optional)') } },
        toArgv: (a) => ['status', ...(a.seed ? ['--seed', String(a.seed)] : [])],
    },
    {
        name: 'compost_blame',
        description: 'Print the three-actor lineage chain for an artifact id (or latest:<kind>=<seed>).',
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
        description: 'Route a file or folder into the seed job queue (audio/video/PDF/DOCX/PPTX/CSV/MD).',
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
        description: 'Retrieve ranked passages from the seed corpus (BM25; no LLM). Use this to ground answers in real utterances before reasoning — each result carries session, time range, and text.',
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
        description: "Read a session's full transcript (utterances, silences, cues, frames) as JSON. Use after compost_search to pull a whole session into context.",
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
        description: 'Create a highlight anchored to an utterance span. Lands as an AI [draft] until a researcher endorses it.',
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
        description: 'Create a code with a definition and optional evidence highlights. Lands as an AI [draft] until endorsed.',
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
            ...(a.seed ? ['--seed', String(a.seed)] : []),
        ],
    },
    {
        name: 'compost_create_theme',
        description: 'Create a theme grouping codes under a summary. Lands as an AI [draft] until endorsed.',
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
        name: 'compost_endorse',
        description: "Endorse an artifact — promotes an AI [draft] to researcher-approved. This is the RESEARCHER's act: the host shows a confirmation, and approving it IS the endorsement. Do not call autonomously to self-approve your own drafts.",
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
    {
        name: 'compost_code_suggest',
        description: 'Cluster un-coded highlights in embedding space and preview candidate codes (no writes). Use to discover what codes the corpus suggests.',
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
        description: 'Persist the clustered code suggestions as AI [draft] code events. Mutation; the drafts await researcher endorsement.',
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
];
export const READ_ONLY_TOOLS = TOOLS.filter((t) => t.readOnly).map((t) => t.name);
export const MUTATION_TOOLS = TOOLS.filter((t) => !t.readOnly).map((t) => t.name);
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
export function resolveCompostInvocation(env = process.env) {
    const override = env.COMPOST_CLI;
    if (override !== undefined && override.trim() !== '') {
        return override.endsWith('.js')
            ? { command: process.execPath, prefixArgs: [override] }
            : { command: override, prefixArgs: [] };
    }
    return { command: 'compost', prefixArgs: [] };
}
const CLI_MISSING_HINT = 'compost CLI not found. Install it (`npm i -g @they-juanreina/compost-cli`, or clone the repo and `pnpm build`), ' +
    'or set COMPOST_CLI to the path of dist/index.js. See docs/install.md.';
const defaultRunner = async (argv) => {
    const { command, prefixArgs } = resolveCompostInvocation();
    try {
        const { stdout } = await execFileAsync(command, [...prefixArgs, ...argv], {
            maxBuffer: 64 * 1024 * 1024,
        });
        return { stdout, code: 0 };
    }
    catch (err) {
        const e = err;
        // ENOENT = the CLI binary/path wasn't found → actionable install hint.
        if (e.code === 'ENOENT') {
            return {
                stdout: JSON.stringify({ error: { code: 'CLI_NOT_FOUND', message: CLI_MISSING_HINT } }),
                code: 1,
            };
        }
        return {
            stdout: e.stdout || e.stderr || String(err),
            code: typeof e.code === 'number' ? e.code : 1,
        };
    }
};
/** Build the argv for a tool, appending AI-authorship flags for aiAuthored
 * tools so the artifact lands as a Claude-Code [draft]. Exposed for tests. */
export function buildArgv(tool, args) {
    const argv = tool.toArgv(args);
    if (tool.aiAuthored === true) {
        // AI-authored events require actor_id + model + prompt_hash (events schema).
        // Supply all three so the create lands as a [draft] instead of failing
        // validation and orphaning the markdown (#165).
        argv.push('--ai', '--actor-id', aiActorId(args), '--model', aiModel(args), '--prompt-hash', argsPromptHash(args));
    }
    return argv;
}
/** Execute a tool by name with args, returning the CLI's JSON text result. */
export async function runTool(name, args, runner = defaultRunner) {
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined)
        return { ok: false, content: `unknown tool: ${name}` };
    const { stdout, code } = await runner(buildArgv(tool, args));
    return { ok: code === 0, content: stdout.trim() };
}
