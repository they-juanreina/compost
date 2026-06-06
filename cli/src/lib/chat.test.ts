import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { Answer } from '@they-juanreina/compost-retrieval'

import { chat } from './chat.js'
import { initSeed } from './seed.js'

const TRANSCRIPT = {
  schema_version: '1.0',
  session_id: 'S001',
  source: 'sessions/S001/source.mp4',
  language: 'es-CO',
  duration_ms: 60000,
  modality: ['audio'],
  speakers: [{ id: 'S2', name: 'P07', type: 'participant' }],
  utterances: [
    {
      id: 'U-0001',
      speaker_id: 'S2',
      turn: 1,
      start_ms: 0,
      end_ms: 3000,
      text: 'No sé si confiar en la alerta automática.',
    },
    {
      id: 'U-0002',
      speaker_id: 'S2',
      turn: 2,
      start_ms: 4000,
      end_ms: 7000,
      text: 'Prefiero verificar manualmente.',
    },
  ],
  silences: [],
  cues: [],
}

describe('chat', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-chat-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  function seedWithSession(): string {
    const { path } = initSeed('demo', { cwd: work })
    const sdir = join(path, 'sessions', 'S001')
    mkdirSync(sdir, { recursive: true })
    writeFileSync(join(sdir, 'transcript.json'), JSON.stringify(TRANSCRIPT))
    return path
  }

  it('returns a cited answer when the model cites a real utterance verbatim', async () => {
    const path = seedWithSession()
    const answerFn = async (): Promise<Answer> => ({
      answer: 'Participants distrust automated alerts.',
      claims: [
        { quote: 'No sé si confiar', utterance_id: 'U-0001', session_id: 'S001', confidence: 0.9 },
      ],
    })
    const result = await chat(path, 'confiar en la alerta', { answerFn, seed: 'demo' })
    assert.equal(result.insufficient_evidence, false)
    assert.equal(result.citations[0]?.utterance_id, 'U-0001')
    // turn persisted
    assert.ok(existsSync(join(path, '.compost/chats/demo/default.jsonl')))
  })

  it('falls back to insufficient_evidence when a citation is fabricated', async () => {
    const path = seedWithSession()
    const answerFn = async (): Promise<Answer> => ({
      answer: 'They love alerts.',
      claims: [
        { quote: 'I love alerts', utterance_id: 'U-9999', session_id: 'S001', confidence: 0.9 },
      ],
    })
    const result = await chat(path, 'confiar en la alerta', { answerFn, seed: 'demo' })
    assert.equal(result.insufficient_evidence, true)
    assert.equal(result.citations.length, 0)
  })

  it('returns insufficient_evidence when the seed has no indexed sessions', async () => {
    const { path } = initSeed('empty', { cwd: work })
    const answerFn = async (): Promise<Answer> => ({ answer: 'x', claims: [] })
    const result = await chat(path, 'cualquier cosa', { answerFn, seed: 'empty' })
    assert.equal(result.insufficient_evidence, true)
    assert.equal(result.retrieved, 0)
  })

  it('persists each turn as JSONL', async () => {
    const path = seedWithSession()
    const answerFn = async (): Promise<Answer> => ({
      answer: 'Distrust.',
      claims: [
        {
          quote: 'verificar manualmente',
          utterance_id: 'U-0002',
          session_id: 'S001',
          confidence: 0.8,
        },
      ],
    })
    await chat(path, 'q1', { answerFn, seed: 'demo', chatId: 'c1' })
    await chat(path, 'q2', { answerFn, seed: 'demo', chatId: 'c1' })
    const lines = readFileSync(join(path, '.compost/chats/demo/c1.jsonl'), 'utf8')
      .trim()
      .split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]!).question, 'q1')
  })
})
