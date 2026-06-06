import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { DoctorReport } from '../lib/doctor.js'
import type { StatusSnapshot } from '../lib/status.js'
import { renderDoctor, renderSearch, renderStatus } from './human.js'

describe('renderStatus', () => {
  it('summarizes seeds and counts as readable lines', () => {
    const snap: StatusSnapshot = {
      schema_version: '1.0',
      generated_at: '2026-06-06T00:00:00Z',
      root: '/x/Seeds',
      seeds: [
        {
          name: 'study',
          path: '/x/Seeds/study',
          status: 'active',
          owners: [],
          created_at: null,
          counts: {
            sessions: { total: 3, transcribed: 2, queued: 1, inbox: 0 },
            highlights: 5,
            codes: 2,
            themes: 1,
            frames: 10,
            insights: 0,
            legacy_assets: 4,
          },
          warnings: ['sessions/foo: not canonical'],
        },
      ],
    }
    const out = renderStatus(snap)
    assert.match(out, /study\s+\[active\]/)
    assert.match(out, /sessions:\s+3 \(2 transcribed, 1 queued, 0 in _inbox\)/)
    assert.match(out, /highlights: 5\s+codes: 2\s+themes: 1/)
    assert.match(out, /⚠ sessions\/foo/)
  })
})

describe('renderSearch', () => {
  it('lists ranked results with time ranges, clipping long text', () => {
    const out = renderSearch({
      query: 'trust',
      returned: 1,
      retrieval: 'hybrid',
      indexed_chunks: 42,
      results: [
        { session: 'S001', start_ms: 65000, end_ms: 72000, score: 0.91, text: 'a '.repeat(200) },
      ],
    })
    assert.match(out, /"trust" — 1 result\(s\) \[hybrid\] of 42 chunks/)
    assert.match(out, /\[S001 1:05–1:12\] score 0.91/)
    assert.match(out, /…$/m) // long text clipped
  })
})

describe('renderDoctor', () => {
  it('shows provider health, task status, and pulled-but-unconfigured models', () => {
    const report: DoctorReport = {
      schema_version: '1.0',
      providers: {
        ollama: { ok: true, latency_ms: 12, model_list: ['llama3.1:8b', 'bge-m3', 'qwen'] },
      },
      tasks: [
        {
          task: 'embeddings',
          route: 'ollama:bge-m3',
          provider: 'ollama',
          model: 'bge-m3',
          status: 'ok',
        },
        {
          task: 'quick_chat',
          route: 'ollama:llama3.1:8b',
          provider: 'ollama',
          model: 'llama3.1:8b',
          status: 'model_missing',
          suggestion: 'ollama pull llama3.1:8b',
        },
      ],
      unused_models: { ollama: ['qwen'] },
      ok: false,
    }
    const out = renderDoctor(report)
    assert.match(out, /models doctor — ISSUES/)
    assert.match(out, /✓ ollama \(3 models, 12ms\)/)
    assert.match(
      out,
      /✗ quick_chat → ollama:llama3.1:8b\s+\[model_missing\]\s+↳ ollama pull llama3.1:8b/,
    )
    assert.match(out, /pulled but unconfigured:/)
    assert.match(out, /ollama: qwen/)
  })
})
