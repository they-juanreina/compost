import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  aiActorId,
  buildArgv,
  type CliRunner,
  isIngestPathAllowed,
  MUTATION_TOOLS,
  PLUGIN_VERSION,
  READ_ONLY_TOOLS,
  resolveCompostInvocation,
  runTool,
  TOOLS,
  type ToolDef,
} from './tools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// AI actor id format: claude-code:<plugin version>:<8-hex args hash>. Derived
// from PLUGIN_VERSION so a version bump doesn't break the assertion.
const AI_ACTOR_RE = new RegExp(`^claude-code:${PLUGIN_VERSION.replace(/\./g, '\\.')}:[a-f0-9]{8}$`)

// Looks up a tool by name and asserts it exists, narrowing away `undefined`
// so callers read the known-present fixture without a non-null assertion.
function tool(name: string): ToolDef {
  const found = TOOLS.find((t) => t.name === name)
  assert.ok(found, `tool ${name} should be defined`)
  return found
}

describe('MCP tool definitions', () => {
  it('separates read-only from mutation tools', () => {
    assert.ok(READ_ONLY_TOOLS.includes('compost_status'))
    assert.ok(READ_ONLY_TOOLS.includes('compost_blame'))
    assert.ok(MUTATION_TOOLS.includes('compost_ingest'))
    assert.ok(MUTATION_TOOLS.includes('compost_transcribe'))
    // no tool is in both sets
    assert.equal(READ_ONLY_TOOLS.filter((n) => MUTATION_TOOLS.includes(n)).length, 0)
  })

  it('every tool has a name, description, and object inputSchema', () => {
    for (const t of TOOLS) {
      assert.ok(t.name.startsWith('compost_'))
      assert.ok(t.description.length > 0)
      assert.equal((t.inputSchema as { type: string }).type, 'object')
    }
  })

  it('maps args to the correct CLI argv', () => {
    const status = tool('compost_status')
    assert.deepEqual(status.toArgv({}), ['status'])
    assert.deepEqual(status.toArgv({ seed: 'demo' }), ['status', '--seed', 'demo'])

    const blame = tool('compost_blame')
    assert.deepEqual(blame.toArgv({ artifact: 'abc123' }), ['blame', 'abc123'])

    const ingest = tool('compost_ingest')
    assert.deepEqual(ingest.toArgv({ path: '/x', seed: 's' }), ['ingest', '/x', '--seed', 's'])

    const dr = tool('compost_models_doctor')
    assert.deepEqual(dr.toArgv({}), ['models', 'doctor'])

    const search = tool('compost_search')
    assert.deepEqual(search.toArgv({ query: 'trust' }), ['search', 'trust'])
    assert.deepEqual(search.toArgv({ query: 'trust', seed: 's', top_k: 5 }), [
      'search',
      'trust',
      '--seed',
      's',
      '--top-k',
      '5',
    ])

    const session = tool('compost_get_session')
    assert.deepEqual(session.toArgv({ session: 'S001' }), ['session', 'S001'])
    assert.deepEqual(session.toArgv({ session: 'S001', seed: 's' }), [
      'session',
      'S001',
      '--seed',
      's',
    ])
  })

  it('classifies the read tools as read-only', () => {
    assert.ok(READ_ONLY_TOOLS.includes('compost_search'))
    assert.ok(READ_ONLY_TOOLS.includes('compost_get_session'))
  })

  it('exposes agreement as a read-only tool (recode is intentionally not a tool)', () => {
    const agree = tool('compost_agreement')
    assert.deepEqual(agree.toArgv({}), ['agreement'])
    assert.deepEqual(agree.toArgv({ seed: 's', min_units: 20 }), [
      'agreement',
      '--seed',
      's',
      '--min-units',
      '20',
    ])
    assert.ok(READ_ONLY_TOOLS.includes('compost_agreement'))
    // recode (the human's blind-coding act) must NOT be agent-callable.
    assert.equal(
      TOOLS.find((t) => t.name === 'compost_recode'),
      undefined,
    )
  })

  it('maps the write tools to `compost create <kind>` / `endorse` argv', () => {
    const hl = tool('compost_create_highlight')
    assert.deepEqual(hl.toArgv({ session: 'S001', utterance: 'U-0002', span: '0,16', text: 'q' }), [
      'create',
      'highlight',
      '--session',
      'S001',
      '--utterance',
      'U-0002',
      '--span',
      '0,16',
      '--text',
      'q',
    ])

    const code = tool('compost_create_code')
    assert.deepEqual(code.toArgv({ name: 'distrust', definition: 'd', evidence: 'H-001' }), [
      'create',
      'code',
      '--name',
      'distrust',
      '--definition',
      'd',
      '--evidence',
      'H-001',
    ])

    const endorse = tool('compost_endorse')
    assert.deepEqual(endorse.toArgv({ artifact: 'abc123' }), ['endorse', 'abc123'])
  })

  it('classifies create_* + endorse as mutations', () => {
    for (const t of [
      'compost_create_highlight',
      'compost_create_code',
      'compost_create_theme',
      'compost_endorse',
    ]) {
      assert.ok(MUTATION_TOOLS.includes(t), `${t} should be a mutation`)
    }
  })

  it('maps the codebook tools to `compost codebook <verb>` argv', () => {
    const create = tool('compost_codebook_new')
    assert.deepEqual(create.toArgv({ name: 'epistemology', stance: 'framework' }), [
      'codebook',
      'new',
      'epistemology',
      '--stance',
      'framework',
    ])
    assert.deepEqual(
      create.toArgv({ name: 'justice', stance: 'framework', description: 'a lens', seed: 's' }),
      [
        'codebook',
        'new',
        'justice',
        '--stance',
        'framework',
        '--description',
        'a lens',
        '--seed',
        's',
      ],
    )

    const list = tool('compost_codebook_list')
    assert.deepEqual(list.toArgv({}), ['codebook', 'list'])
    assert.deepEqual(list.toArgv({ seed: 'demo' }), ['codebook', 'list', '--seed', 'demo'])

    const migrate = tool('compost_codebook_migrate')
    assert.deepEqual(migrate.toArgv({}), ['codebook', 'migrate'])
    assert.deepEqual(migrate.toArgv({ seed: 'demo', apply: true }), [
      'codebook',
      'migrate',
      '--seed',
      'demo',
      '--apply',
    ])
    // apply:false must NOT pass the flag (dry-run is the safe default).
    assert.deepEqual(migrate.toArgv({ apply: false }), ['codebook', 'migrate'])
  })

  it('forwards --codebook on agreement only when given (per-frame κ)', () => {
    const agree = tool('compost_agreement')
    assert.deepEqual(agree.toArgv({ codebook: 'epistemology' }), [
      'agreement',
      '--codebook',
      'epistemology',
    ])
    assert.ok(!agree.toArgv({ seed: 's' }).includes('--codebook'))
  })

  it('forwards --codebook on create_code only when given', () => {
    const code = tool('compost_create_code')
    assert.deepEqual(code.toArgv({ name: 'c', definition: 'd', codebook: 'epistemology' }), [
      'create',
      'code',
      '--name',
      'c',
      '--definition',
      'd',
      '--codebook',
      'epistemology',
    ])
    assert.ok(!code.toArgv({ name: 'c', definition: 'd' }).includes('--codebook'))
  })

  it('classifies codebook_list read-only, codebook_new/migrate as mutations (not AI-authored)', () => {
    assert.ok(tool('compost_codebook_list').readOnly)
    assert.equal(tool('compost_codebook_new').readOnly, false)
    assert.equal(tool('compost_codebook_migrate').readOnly, false)
    // Lens setup / migration is the researcher's act — never an AI [draft].
    assert.notEqual(tool('compost_codebook_new').aiAuthored, true)
    assert.notEqual(tool('compost_codebook_migrate').aiAuthored, true)
    assert.ok(
      !buildArgv(tool('compost_codebook_new'), { name: 'x', stance: 'inductive' }).includes('--ai'),
    )
  })

  it('buildArgv appends AI authorship flags ONLY for aiAuthored tools', () => {
    const hl = tool('compost_create_highlight')
    const args = { session: 'S001', utterance: 'U-1', span: '0,5', text: 'hello' }
    const argv = buildArgv(hl, args)
    assert.ok(argv.includes('--ai'))
    const idIdx = argv.indexOf('--actor-id')
    assert.ok(idIdx > 0)
    assert.equal(argv[idIdx + 1], aiActorId(args))
    assert.match(argv[idIdx + 1] as string, AI_ACTOR_RE)

    // endorse is NOT ai-authored — no --ai injected (researcher's act).
    const endorse = tool('compost_endorse')
    const eArgv = buildArgv(endorse, { artifact: 'abc123' })
    assert.ok(!eArgv.includes('--ai'))
  })

  it('compost_endorse never forwards a researcher arg — identity is server-side (#236)', () => {
    const endorse = tool('compost_endorse')
    // Even if a model supplies `researcher`, it must not reach the CLI argv.
    const argv = endorse.toArgv({ artifact: 'abc123', researcher: 'someone-else' })
    assert.ok(!argv.includes('--researcher'))
    assert.deepEqual(argv, ['endorse', 'abc123'])
    // …and the schema doesn't advertise the arg.
    const props = (endorse.inputSchema as { properties: Record<string, unknown> }).properties
    assert.ok(!('researcher' in props))
  })

  it('buildArgv supplies the schema-required model + prompt_hash for AI creates (#165)', () => {
    // actor_type=ai events require model + a 64-hex prompt_hash; without them the
    // CLI fails schema validation and orphans the markdown.
    const code = tool('compost_create_code')
    const argv = buildArgv(code, { name: 'distrust', definition: 'x' })
    const phIdx = argv.indexOf('--prompt-hash')
    assert.ok(phIdx > 0, '--prompt-hash should be injected')
    assert.match(argv[phIdx + 1] as string, /^[a-f0-9]{64}$/)
    const mIdx = argv.indexOf('--model')
    assert.ok(mIdx > 0, '--model should be injected')
    assert.equal(argv[mIdx + 1], 'claude-code') // sentinel when the agent omits its model id
  })

  it('buildArgv records the agent-supplied model id when present (#165)', () => {
    const theme = tool('compost_create_theme')
    const argv = buildArgv(theme, { name: 't', summary: 's', model: 'claude-opus-4-8' })
    const mIdx = argv.indexOf('--model')
    assert.equal(argv[mIdx + 1], 'claude-opus-4-8')
  })

  it('aiActorId is deterministic on args and stamped with plugin version', () => {
    const a = aiActorId({ name: 'x', definition: 'y' })
    const b = aiActorId({ name: 'x', definition: 'y' })
    assert.equal(a, b)
    assert.match(a, AI_ACTOR_RE)
  })

  it('compost_create_memo is an AI [draft] author and maps title/content/anchors', () => {
    const memo = tool('compost_create_memo')
    assert.equal(memo.aiAuthored, true)
    assert.ok(MUTATION_TOOLS.includes('compost_create_memo'))
    const argv = buildArgv(memo, {
      title: 'On distrust',
      content: 'procedural, not personal',
      type: 'code',
      anchor: ['code:distrust', 'highlight:H-001'],
    })
    assert.deepEqual(argv.slice(0, 5), [
      'memo',
      'new',
      'On distrust',
      '--content',
      'procedural, not personal',
    ])
    // each anchor expands to its own --anchor flag
    assert.equal(argv.filter((x) => x === '--anchor').length, 2)
    // born [draft]: AI flags + schema-required model/prompt-hash injected
    assert.ok(argv.includes('--ai'))
    assert.match(argv[argv.indexOf('--prompt-hash') + 1] as string, /^[a-f0-9]{64}$/)
  })

  it('compost_list_memos is read-only and maps the --about filter', () => {
    assert.ok(READ_ONLY_TOOLS.includes('compost_list_memos'))
    const argv = tool('compost_list_memos').toArgv({ about: 'C-distrust', seed: 'study' })
    assert.deepEqual(argv, ['memo', 'list', '--about', 'C-distrust', '--seed', 'study'])
  })
})

describe('runTool', () => {
  it('invokes the runner with the mapped argv and returns its output', async () => {
    let seen: string[] = []
    const runner: CliRunner = async (argv) => {
      seen = argv
      return { stdout: '{"status":"ok"}', code: 0 }
    }
    const res = await runTool('compost_status', { seed: 'demo' }, runner)
    assert.deepEqual(seen, ['status', '--seed', 'demo'])
    assert.ok(res.ok)
    assert.equal(res.content, '{"status":"ok"}')
  })

  it('reports failure on non-zero exit', async () => {
    const runner: CliRunner = async () => ({ stdout: 'boom', code: 2 })
    const res = await runTool('compost_transcribe', { session: 'S001' }, runner)
    assert.equal(res.ok, false)
  })

  it('rejects an unknown tool', async () => {
    const res = await runTool('compost_nope', {})
    assert.equal(res.ok, false)
    assert.match(res.content, /unknown tool/)
  })

  it('confines compost_ingest to the workspace by default (#236)', async () => {
    const cwd = '/home/u/project'
    // In-workspace paths are allowed.
    assert.ok(isIngestPathAllowed('./recording.m4a', {}, cwd))
    assert.ok(isIngestPathAllowed('interviews/a.mp3', {}, cwd))
    assert.ok(isIngestPathAllowed('/home/u/project/sub/a.mp3', {}, cwd))
    // Escapes / arbitrary absolute paths are denied.
    assert.ok(!isIngestPathAllowed('/home/u/.ssh/id_rsa', {}, cwd))
    assert.ok(!isIngestPathAllowed('../sibling-repo/secrets.txt', {}, cwd))
    // COMPOST_INGEST_ROOTS extends the allow-list.
    assert.ok(
      isIngestPathAllowed('/data/audio/a.mp3', { COMPOST_INGEST_ROOTS: '/data/audio' }, cwd),
    )
  })

  it('runTool blocks an out-of-workspace ingest before invoking the CLI', async () => {
    let called = false
    const runner: CliRunner = async () => {
      called = true
      return { stdout: '{}', code: 0 }
    }
    // An absolute path well outside any plausible workspace root.
    const res = await runTool('compost_ingest', { path: '/etc/shadow' }, runner)
    assert.equal(res.ok, false)
    assert.match(res.content, /INGEST_PATH_DENIED/)
    assert.equal(called, false) // the CLI was never run
  })

  it('maps code_suggest (read) and code_apply (mutation) to `compost code`', () => {
    const suggest = tool('compost_code_suggest')
    assert.deepEqual(suggest.toArgv({ seed: 's' }), ['code', '--seed', 's'])
    assert.ok(READ_ONLY_TOOLS.includes('compost_code_suggest'))

    const apply = tool('compost_code_apply')
    assert.deepEqual(apply.toArgv({ seed: 's', threshold: 0.8 }), [
      'code',
      '--apply',
      '--seed',
      's',
      '--threshold',
      '0.8',
    ])
    assert.ok(MUTATION_TOOLS.includes('compost_code_apply'))
    // code_apply authorship is the scanner agent, not Claude Code → no --ai.
    assert.ok(!buildArgv(apply, { seed: 's' }).includes('--ai'))
  })
})

describe('resolveCompostInvocation', () => {
  it('runs a COMPOST_CLI .js path via node', () => {
    const r = resolveCompostInvocation({ COMPOST_CLI: '/opt/compost/dist/index.js' })
    assert.equal(r.command, process.execPath)
    assert.deepEqual(r.prefixArgs, ['/opt/compost/dist/index.js'])
  })

  it('runs a COMPOST_CLI non-.js path as an executable', () => {
    const r = resolveCompostInvocation({ COMPOST_CLI: '/usr/local/bin/compost' })
    assert.equal(r.command, '/usr/local/bin/compost')
    assert.deepEqual(r.prefixArgs, [])
  })

  it('falls back to `compost` on PATH when COMPOST_CLI is unset/blank', () => {
    assert.deepEqual(resolveCompostInvocation({}), { command: 'compost', prefixArgs: [] })
    assert.deepEqual(resolveCompostInvocation({ COMPOST_CLI: '  ' }), {
      command: 'compost',
      prefixArgs: [],
    })
  })
})

describe('plugin manifest', () => {
  it('declares the MCP server, commands dir, and skills', () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'),
    )
    assert.equal(manifest.name, 'compost')
    assert.ok(manifest.mcpServers?.compost)
    assert.equal(manifest.commands, './commands')
    assert.ok(Array.isArray(manifest.skills))
    assert.ok(manifest.skills.includes('thematic-coding'))
  })
})
