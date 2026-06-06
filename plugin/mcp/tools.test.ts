import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  aiActorId,
  buildArgv,
  type CliRunner,
  MUTATION_TOOLS,
  READ_ONLY_TOOLS,
  resolveCompostInvocation,
  runTool,
  TOOLS,
} from './tools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
    const status = TOOLS.find((t) => t.name === 'compost_status')!
    assert.deepEqual(status.toArgv({}), ['status'])
    assert.deepEqual(status.toArgv({ seed: 'demo' }), ['status', '--seed', 'demo'])

    const blame = TOOLS.find((t) => t.name === 'compost_blame')!
    assert.deepEqual(blame.toArgv({ artifact: 'abc123' }), ['blame', 'abc123'])

    const ingest = TOOLS.find((t) => t.name === 'compost_ingest')!
    assert.deepEqual(ingest.toArgv({ path: '/x', seed: 's' }), ['ingest', '/x', '--seed', 's'])

    const dr = TOOLS.find((t) => t.name === 'compost_models_doctor')!
    assert.deepEqual(dr.toArgv({}), ['models', 'doctor'])

    const search = TOOLS.find((t) => t.name === 'compost_search')!
    assert.deepEqual(search.toArgv({ query: 'trust' }), ['search', 'trust'])
    assert.deepEqual(search.toArgv({ query: 'trust', seed: 's', top_k: 5 }), [
      'search',
      'trust',
      '--seed',
      's',
      '--top-k',
      '5',
    ])

    const session = TOOLS.find((t) => t.name === 'compost_get_session')!
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

  it('maps the write tools to `compost create <kind>` / `endorse` argv', () => {
    const hl = TOOLS.find((t) => t.name === 'compost_create_highlight')!
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

    const code = TOOLS.find((t) => t.name === 'compost_create_code')!
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

    const endorse = TOOLS.find((t) => t.name === 'compost_endorse')!
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

  it('buildArgv appends AI authorship flags ONLY for aiAuthored tools', () => {
    const hl = TOOLS.find((t) => t.name === 'compost_create_highlight')!
    const args = { session: 'S001', utterance: 'U-1', span: '0,5', text: 'hello' }
    const argv = buildArgv(hl, args)
    assert.ok(argv.includes('--ai'))
    const idIdx = argv.indexOf('--actor-id')
    assert.ok(idIdx > 0)
    assert.equal(argv[idIdx + 1], aiActorId(args))
    assert.match(argv[idIdx + 1] as string, /^claude-code:0\.1\.0-rc\.2:[a-f0-9]{8}$/)

    // endorse is NOT ai-authored — no --ai injected (researcher's act).
    const endorse = TOOLS.find((t) => t.name === 'compost_endorse')!
    const eArgv = buildArgv(endorse, { artifact: 'abc123' })
    assert.ok(!eArgv.includes('--ai'))
  })

  it('buildArgv supplies the schema-required model + prompt_hash for AI creates (#165)', () => {
    // actor_type=ai events require model + a 64-hex prompt_hash; without them the
    // CLI fails schema validation and orphans the markdown.
    const code = TOOLS.find((t) => t.name === 'compost_create_code')!
    const argv = buildArgv(code, { name: 'distrust', definition: 'x' })
    const phIdx = argv.indexOf('--prompt-hash')
    assert.ok(phIdx > 0, '--prompt-hash should be injected')
    assert.match(argv[phIdx + 1] as string, /^[a-f0-9]{64}$/)
    const mIdx = argv.indexOf('--model')
    assert.ok(mIdx > 0, '--model should be injected')
    assert.equal(argv[mIdx + 1], 'claude-code') // sentinel when the agent omits its model id
  })

  it('buildArgv records the agent-supplied model id when present (#165)', () => {
    const theme = TOOLS.find((t) => t.name === 'compost_create_theme')!
    const argv = buildArgv(theme, { name: 't', summary: 's', model: 'claude-opus-4-8' })
    const mIdx = argv.indexOf('--model')
    assert.equal(argv[mIdx + 1], 'claude-opus-4-8')
  })

  it('aiActorId is deterministic on args and stamped with plugin version', () => {
    const a = aiActorId({ name: 'x', definition: 'y' })
    const b = aiActorId({ name: 'x', definition: 'y' })
    assert.equal(a, b)
    assert.match(a, /^claude-code:0\.1\.0-rc\.2:[a-f0-9]{8}$/)
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

  it('maps code_suggest (read) and code_apply (mutation) to `compost code`', () => {
    const suggest = TOOLS.find((t) => t.name === 'compost_code_suggest')!
    assert.deepEqual(suggest.toArgv({ seed: 's' }), ['code', '--seed', 's'])
    assert.ok(READ_ONLY_TOOLS.includes('compost_code_suggest'))

    const apply = TOOLS.find((t) => t.name === 'compost_code_apply')!
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
