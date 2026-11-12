import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

import { listTranscriptIngests, sha256Bytes } from '../lib/ingestProvenance.js'
import { initSeed } from '../lib/seed.js'
import { gatherStatus } from '../lib/status.js'
import { buildProgram } from '../router.js'

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Juan>Welcome.</v>\n'
const SRT = '1\n00:00:01,000 --> 00:00:04,000\nJuan: Welcome.\n'
const TXT = '[00:00:01] Juan: Welcome.\n[00:00:05] P07: Thanks.\n'

describe('compost import emits one ingest-provenance event (#325)', () => {
  let work: string
  let seed: string
  let prevCwd: string

  beforeEach(() => {
    prevCwd = process.cwd()
    work = mkdtempSync(join(tmpdir(), 'compost-import-'))
    seed = initSeed('demo', { cwd: work }).path
    process.chdir(work)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(work, { recursive: true, force: true })
  })

  async function runImport(file: string, ...extra: string[]): Promise<Record<string, unknown>> {
    const chunks: string[] = []
    const realWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((s: string) => {
      chunks.push(String(s))
      return true
    }) as typeof process.stdout.write
    try {
      await buildProgram().parseAsync(['node', 'compost', '--json', 'import', file, ...extra])
    } finally {
      process.stdout.write = realWrite
    }
    return JSON.parse(chunks.join('')) as Record<string, unknown>
  }

  for (const [name, body, format] of [
    ['teams.vtt', VTT, 'vtt'],
    ['zoom.srt', SRT, 'srt'],
    ['interview.txt', TXT, 'txt'],
  ] as const) {
    it(`${format}: one researcher event with format, parser and source sha256`, async () => {
      const file = join(work, name)
      writeFileSync(file, body)
      const out = await runImport(file)
      assert.equal(out.status, 'ok')

      const events = listTranscriptIngests(seed)
      assert.equal(events.length, 1, 'exactly one event, not per-format or per-step')
      assert.deepEqual(
        { ...events[0], ingested_at: undefined },
        {
          session_id: out.session,
          original_name: name,
          source_uri: pathToFileURL(file).href,
          format,
          parser: 'compost-import',
          parser_version: '0.1.0',
          ingested_at: undefined,
          actor: 'researcher',
          sha256: sha256Bytes(Buffer.from(body)),
        },
      )
      assert.ok(!Number.isNaN(Date.parse(events[0]?.ingested_at ?? '')))
      assert.equal(out.duplicate_of, undefined)
    })
  }

  it('re-importing the same file flags the duplicate in the import result and in status', async () => {
    const file = join(work, 'teams.vtt')
    writeFileSync(file, VTT)
    await runImport(file, '--session', 'first')
    const second = await runImport(file, '--session', 'second')
    assert.deepEqual(second.duplicate_of, ['first'])

    const sha = sha256Bytes(Buffer.from(VTT))
    const status = gatherStatus({ cwd: work }).seeds[0]
    assert.match(status?.warnings.join('\n') ?? '', /ingested into more than one session/)
    assert.deepEqual(status?.duplicate_ingests, [
      { sha256: sha, count: 2, sessions: ['first', 'second'], original_names: ['teams.vtt'] },
    ])
  })
})
