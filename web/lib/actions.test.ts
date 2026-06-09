import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '@they-juanreina/compost-cli/engine'

import {
  createArtifact,
  endorse,
  getArtifactByRef,
  listArtifactsOfKind,
  reject,
  update,
} from './actions.js'
import { ApiError } from './server/http.js'

const RESEARCHER = { actorType: 'researcher' as const, actorId: 'juan@example.com' }
const AI = {
  actorType: 'ai' as const,
  actorId: 'claude-code:0.1.0:abc12345',
  model: 'anthropic:claude',
  promptHash: 'f'.repeat(64),
}

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'compost-web-actions-'))
  mkdirSync(join(work, 'Seeds', 'demo'), { recursive: true })
  process.env.COMPOST_ROOT = work
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
  delete process.env.COMPOST_ROOT
})

function apiCode(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof ApiError) return err.code
    throw err
  }
  throw new Error('expected an ApiError to be thrown')
}

describe('createArtifact', () => {
  it('creates a researcher highlight (human_approved) through the engine write path', () => {
    const res = createArtifact('demo', 'highlight', RESEARCHER, {
      sessionId: 'S001',
      utteranceId: 'U-1',
      span: [0, 5],
      text: 'No sé',
    })
    assert.equal(res.id, 'H-001')
    assert.equal(res.artifact_id.length, 64)
    assert.equal(res.snapshot?.human_approved, true)
  })

  it('creates an AI code as a draft (not human_approved)', () => {
    const res = createArtifact('demo', 'code', AI, { name: 'Distrust', definition: 'd' })
    assert.equal(res.id, 'C-distrust')
    assert.equal(res.snapshot?.human_approved, false)
  })

  it('rejects a body missing a required field with SCHEMA_ERROR', () => {
    assert.equal(
      apiCode(() => createArtifact('demo', 'highlight', RESEARCHER, { sessionId: 'S001' })),
      'SCHEMA_ERROR',
    )
  })

  it('rejects a bad span shape with SCHEMA_ERROR', () => {
    assert.equal(
      apiCode(() =>
        createArtifact('demo', 'highlight', RESEARCHER, {
          sessionId: 'S001',
          utteranceId: 'U-1',
          span: [0],
          text: 'x',
        }),
      ),
      'SCHEMA_ERROR',
    )
  })

  it('surfaces NOT_IN_SEED for a missing seed (the route layer maps it to 404)', () => {
    assert.throws(
      () =>
        createArtifact('nope', 'highlight', RESEARCHER, {
          sessionId: 'S001',
          utteranceId: 'U-1',
          span: [0, 1],
          text: 'x',
        }),
      (e) => e instanceof CompostError && e.code === 'NOT_IN_SEED',
    )
  })
})

describe('read + lifecycle', () => {
  it('lists created artifacts and hides rejected ones', () => {
    createArtifact('demo', 'highlight', RESEARCHER, {
      sessionId: 'S001',
      utteranceId: 'U-1',
      span: [0, 1],
      text: 'a',
    })
    createArtifact('demo', 'highlight', RESEARCHER, {
      sessionId: 'S001',
      utteranceId: 'U-2',
      span: [0, 1],
      text: 'b',
    })
    assert.equal(listArtifactsOfKind('demo', 'highlight').length, 2)

    reject('demo', 'highlight', 'H-001', 'juan@example.com')
    assert.equal(listArtifactsOfKind('demo', 'highlight').length, 1)
    assert.equal(listArtifactsOfKind('demo', 'highlight', { includeArchived: true }).length, 2)
  })

  it('endorse promotes an AI draft', () => {
    createArtifact('demo', 'code', AI, { name: 'Trust', definition: 'd' })
    assert.equal(getArtifactByRef('demo', 'code', 'C-trust').human_approved, false)
    const after = endorse('demo', 'code', 'C-trust', 'juan@example.com')
    assert.equal(after.human_approved, true)
  })

  it('getArtifactByRef throws NOT_FOUND for an unknown ref', () => {
    assert.equal(
      apiCode(() => getArtifactByRef('demo', 'code', 'C-nope')),
      'NOT_FOUND',
    )
  })

  it('update applies a field patch', () => {
    createArtifact('demo', 'code', RESEARCHER, { name: 'Distrust', definition: 'old' })
    const after = update('demo', 'code', 'C-distrust', RESEARCHER, {
      field: 'definition',
      before: 'old',
      after: 'new',
    })
    assert.equal((after.current_state as { definition: string }).definition, 'new')
  })
})

describe('optimistic concurrency', () => {
  it('rejects a stale endorse with CONFLICT', () => {
    createArtifact('demo', 'code', AI, { name: 'Distrust', definition: 'd' })
    // current version is 1; a stale client thinks it's at 99
    assert.equal(
      apiCode(() => endorse('demo', 'code', 'C-distrust', 'juan@example.com', 99)),
      'CONFLICT',
    )
    // correct version succeeds
    assert.equal(endorse('demo', 'code', 'C-distrust', 'juan@example.com', 1).human_approved, true)
  })
})
