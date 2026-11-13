import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createCategory, createCode, createTheme } from '../lib/artifacts.js'
import { blame } from '../lib/blame.js'
import { getArtifact } from '../lib/reads.js'
import { initSeed } from '../lib/seed.js'
import { editThemeEvidence } from '../lib/themeEvidence.js'
import { renderThemeEvidenceEdit } from '../render/human.js'
import { buildProgram } from '../router.js'

const RESEARCHER = { actorType: 'researcher' as const, actorId: 'juan@example.com' }
const AI = {
  actorType: 'ai' as const,
  actorId: 'claude-code:0.2.2:abc12345',
  model: 'anthropic:claude',
  promptHash: 'f'.repeat(64),
}
const AI_FLAGS = [
  '--ai',
  '--actor-id',
  AI.actorId,
  '--model',
  AI.model,
  '--prompt-hash',
  AI.promptHash,
]

async function runCli(...argv: string[]): Promise<Record<string, unknown>> {
  const chunks: string[] = []
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((s: string) => {
    chunks.push(String(s))
    return true
  }) as typeof process.stdout.write
  try {
    await buildProgram().parseAsync(['node', 'compost', '--json', ...argv])
  } finally {
    process.stdout.write = realWrite
  }
  return JSON.parse(chunks.join('')) as Record<string, unknown>
}

class ExitSignal extends Error {
  constructor(readonly exitCode: number) {
    super(`process.exit(${exitCode})`)
  }
}

/** Run a command that must fail: returns the structured error the CLI printed
 * on stderr and the exit code it asked for. */
async function runCliError(
  ...argv: string[]
): Promise<{ code: string; message: string; exitCode: number }> {
  const chunks: string[] = []
  const realErr = process.stderr.write.bind(process.stderr)
  const realExit = process.exit
  process.stderr.write = ((s: string) => {
    chunks.push(String(s))
    return true
  }) as typeof process.stderr.write
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0)
  }) as typeof process.exit
  let exitCode = -1
  try {
    await buildProgram().parseAsync(['node', 'compost', '--json', ...argv])
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err
    exitCode = err.exitCode
  } finally {
    process.stderr.write = realErr
    process.exit = realExit
  }
  assert.notEqual(exitCode, -1, 'expected the command to exit with an error')
  const parsed = JSON.parse(chunks.join('')) as { error: { code: string; message: string } }
  return { ...parsed.error, exitCode }
}

describe('compost theme add|remove (#335)', () => {
  let work: string
  let seed: string
  let prevCwd: string
  let themeId: string
  let themePath: string

  beforeEach(() => {
    prevCwd = process.cwd()
    work = mkdtempSync(join(tmpdir(), 'compost-theme-cmd-'))
    seed = initSeed('demo', { cwd: work }).path
    createCode(seed, { name: 'distrust', definition: 'd', author: RESEARCHER })
    createCode(seed, { name: 'override', definition: 'o', author: RESEARCHER })
    createCategory(seed, { name: 'agency', definition: 'a', author: RESEARCHER })
    const theme = createTheme(seed, {
      name: 'control',
      summary: 's',
      evidence: [{ kind: 'code', ref: 'C-distrust' }],
      author: RESEARCHER,
    })
    themeId = theme.id
    themePath = theme.path
    process.chdir(work)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(work, { recursive: true, force: true })
  })

  it('theme add: parses kind:ref (bare = code), records one researcher update', async () => {
    const out = await runCli(
      'theme',
      'add',
      themeId,
      '--evidence',
      'C-override,category:CAT-agency',
      '--actor-id',
      'juan@example.com',
    )
    assert.equal(out.status, 'ok')
    assert.equal(out.command, 'theme add')
    assert.equal(out.id, themeId)
    assert.equal(out.changed, true)
    assert.equal(out.state, 'endorsed')
    assert.deepEqual(out.added, [
      { kind: 'code', ref: 'C-primary/override', codebook_id: 'CB-primary' },
      { kind: 'category', ref: 'CAT-agency', codebook_id: 'CB-primary' },
    ])
    assert.equal(typeof out.update_event_id, 'string')
    assert.equal(out.file_rewritten, true)
    assert.match(
      readFileSync(themePath, 'utf8'),
      /^evidence: \[code:C-distrust:CB-primary, code:C-primary\/override:CB-primary, category:CAT-agency:CB-primary\]$/m,
    )

    const lineage = blame(themeId, { cwd: work, seed: 'demo' })
    const last = lineage.events.at(-1)
    assert.equal(last?.action, 'update')
    assert.equal(last?.actor_type, 'researcher')
    assert.equal(last?.actor_id, 'juan@example.com')
    assert.equal(last?.id, out.update_event_id)
  })

  it('theme remove: takes --seed and drops the entry', async () => {
    editThemeEvidence(seed, themeId, { add: [{ kind: 'code', ref: 'C-override' }] }, RESEARCHER)
    const out = await runCli(
      'theme',
      'remove',
      themeId,
      '--evidence',
      'code:C-distrust',
      '--seed',
      'demo',
      '--actor-id',
      'juan@example.com',
    )
    assert.equal(out.status, 'ok')
    assert.equal(out.command, 'theme remove')
    assert.deepEqual(out.removed, [{ kind: 'code', ref: 'C-distrust', codebook_id: 'CB-primary' }])
    assert.deepEqual(out.evidence, [
      { kind: 'code', ref: 'C-primary/override', codebook_id: 'CB-primary' },
    ])
  })

  it('a repeat is `unchanged`: no event id, same evidence', async () => {
    const args = [
      'theme',
      'add',
      themeId,
      '--evidence',
      'C-override',
      '--actor-id',
      'j@example.com',
    ]
    const first = await runCli(...args)
    const second = await runCli(...args)
    assert.equal(first.status, 'ok')
    assert.equal(second.status, 'unchanged')
    assert.equal(second.changed, false)
    assert.equal(second.update_event_id, undefined)
    assert.deepEqual(second.already_present, [
      { kind: 'code', ref: 'C-primary/override', codebook_id: 'CB-primary' },
    ])
    assert.deepEqual(second.evidence, first.evidence)
    assert.equal(blame(themeId, { cwd: work, seed: 'demo' }).events.length, 2) // create + 1 update
  })

  it('--ai on an endorsed theme exits 1 with the structured refusal', async () => {
    const err = await runCliError('theme', 'add', themeId, '--evidence', 'C-override', ...AI_FLAGS)
    assert.equal(err.exitCode, 1)
    assert.equal(err.code, 'INVALID_INPUT')
    assert.match(err.message, /is endorsed/)
    assert.match(err.message, /ask them to run `compost theme add\|remove/)
    assert.equal(blame(themeId, { cwd: work, seed: 'demo' }).events.length, 1, 'no event')
  })

  it('--ai on an AI [draft] records an ai update and leaves it a draft', async () => {
    const draft = createTheme(seed, {
      name: 'ai-idea',
      summary: 's',
      evidence: [{ kind: 'code', ref: 'C-distrust' }],
      author: AI,
    })
    const out = await runCli('theme', 'add', draft.id, '--evidence', 'C-override', ...AI_FLAGS)
    assert.equal(out.status, 'ok')
    assert.equal(out.state, 'draft')
    const last = blame(draft.id, { cwd: work, seed: 'demo' }).events.at(-1)
    assert.equal(last?.actor_type, 'ai')
    assert.equal(last?.actor_id, AI.actorId)
    assert.equal(last?.model, AI.model)
    assert.equal(getArtifact(seed, 'theme', draft.id)?.human_approved, false)
  })

  it('--ai without its provenance flags fails before anything is written', async () => {
    const err = await runCliError('theme', 'add', themeId, '--evidence', 'C-override', '--ai')
    assert.equal(err.code, 'INVALID_INPUT')
    assert.match(err.message, /--ai requires --actor-id, --model, --prompt-hash/)
  })

  it('refusals from the core surface unchanged: memo on add, last evidence on remove', async () => {
    const memo = await runCliError(
      'theme',
      'add',
      themeId,
      '--evidence',
      'memo:M-001',
      '--actor-id',
      'j@example.com',
    )
    assert.equal(memo.code, 'INVALID_INPUT')
    assert.match(memo.message, /code or category evidence only/)

    const last = await runCliError(
      'theme',
      'remove',
      themeId,
      '--evidence',
      'C-distrust',
      '--actor-id',
      'j@example.com',
    )
    assert.equal(last.code, 'INVALID_INPUT')
    assert.match(last.message, new RegExp(`compost reject ${themeId}`))
  })

  it('rejects a malformed --evidence token', async () => {
    const kind = await runCliError(
      'theme',
      'add',
      themeId,
      '--evidence',
      'term:x',
      '--actor-id',
      'j@example.com',
    )
    assert.equal(kind.code, 'INVALID_INPUT')
    assert.match(kind.message, /Evidence kind must be code \| category \| memo/)
  })

  it('add and remove take --seed and the shared actor flags — but not --inputs-file', () => {
    const sub = (path: string[]) => {
      let cmd = buildProgram()
      for (const name of path) {
        const next = cmd.commands.find((c) => c.name() === name)
        assert.ok(next, `compost ${path.join(' ')} should exist`)
        cmd = next
      }
      return cmd.options.map((o) => o.long)
    }
    for (const op of ['add', 'remove']) {
      assert.deepEqual(sub(['theme', op]), [
        '--evidence',
        '--seed',
        '--ai',
        '--actor-id',
        '--model',
        '--prompt-hash',
      ])
    }
    // An update event carries no input bundle; create still takes one.
    assert.ok(sub(['create', 'theme']).includes('--inputs-file'))
  })

  it('renders a readable summary for --human', () => {
    const changed = editThemeEvidence(
      seed,
      themeId,
      {
        add: [
          { kind: 'code', ref: 'C-override' },
          { kind: 'code', ref: 'C-distrust' },
        ],
      },
      RESEARCHER,
    )
    const text = renderThemeEvidenceEdit({ status: 'ok', command: 'theme add', ...changed })
    assert.match(text, new RegExp(`theme add ${themeId} — recorded \\(event [0-9A-Z]{26}\\)`))
    assert.match(text, /the theme stays endorsed/)
    assert.match(text, /added: +code:C-primary\/override/)
    assert.match(text, /already present: +code:C-distrust/)
    assert.match(text, /evidence now: +code:C-distrust, code:C-primary\/override/)

    const noop = editThemeEvidence(
      seed,
      themeId,
      { remove: [{ kind: 'category', ref: 'CAT-agency' }] },
      RESEARCHER,
    )
    const quiet = renderThemeEvidenceEdit({ status: 'unchanged', command: 'theme remove', ...noop })
    assert.match(quiet, /nothing to change \(no event recorded\)/)
    assert.match(quiet, /not on theme: +category:CAT-agency/)
    assert.doesNotMatch(quiet, /NOT restamped/)

    // A skipped restamp is shown, not buried in a boolean.
    const warned = renderThemeEvidenceEdit({
      status: 'ok',
      command: 'theme add',
      ...changed,
      file_rewritten: false,
      warning: 'The ledger was updated, but the markdown at x.md was NOT restamped.',
    })
    assert.match(warned, /⚠ The ledger was updated, but the markdown at x\.md was NOT restamped\./)
  })
})
