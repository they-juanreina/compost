import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { MUTATION_TOOLS, READ_ONLY_TOOLS, runTool, TOOLS, type CliRunner } from './tools.js'

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
