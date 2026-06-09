import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { collectionRoute, endorseRoute, itemRoute, rejectRoute } from './artifactRoutes.js'

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'compost-web-routes-'))
  mkdirSync(join(work, 'Seeds', 'demo'), { recursive: true })
  process.env.COMPOST_ROOT = work
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
  delete process.env.COMPOST_ROOT
})

function ctx<T>(params: T) {
  return { params: Promise.resolve(params) }
}
function jsonReq(method: string, body?: unknown): Request {
  return new Request('http://localhost/api', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

describe('artifact CRUD routes', () => {
  it('POST creates (201) and GET lists (200)', async () => {
    const { GET, POST } = collectionRoute('highlights')
    const created = await POST(
      jsonReq('POST', { sessionId: 'S001', utteranceId: 'U-1', span: [0, 5], text: 'hi' }),
      ctx({ seed: 'demo' }),
    )
    assert.equal(created.status, 201)
    const createdBody = (await created.json()) as { id: string }
    assert.equal(createdBody.id, 'H-001')

    const listed = await GET(jsonReq('GET'), ctx({ seed: 'demo' }))
    assert.equal(listed.status, 200)
    assert.equal(((await listed.json()) as unknown[]).length, 1)
  })

  it('POST with an invalid body returns 422 SCHEMA_ERROR envelope', async () => {
    const { POST } = collectionRoute('highlights')
    const res = await POST(jsonReq('POST', { sessionId: 'S001' }), ctx({ seed: 'demo' }))
    assert.equal(res.status, 422)
    assert.equal(((await res.json()) as { error: string }).error, 'SCHEMA_ERROR')
  })

  it('GET an unknown item returns 404 NOT_FOUND envelope', async () => {
    const { GET } = itemRoute('codes')
    const res = await GET(jsonReq('GET'), ctx({ seed: 'demo', id: 'C-nope' }))
    assert.equal(res.status, 404)
    assert.equal(((await res.json()) as { error: string }).error, 'NOT_FOUND')
  })

  it('endorse promotes a draft; a stale endorse returns 409 CONFLICT', async () => {
    const { POST: create } = collectionRoute('codes')
    // AI author via the structured actor header → starts as a [draft]
    const aiCreate = new Request('http://localhost/api', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-compost-actor': JSON.stringify({
          type: 'ai',
          id: 'claude-code:0.1.0:abc',
          model: 'anthropic:claude',
          promptHash: 'f'.repeat(64),
        }),
      },
      body: JSON.stringify({ name: 'Distrust', definition: 'd' }),
    })
    const createdRes = await create(aiCreate, ctx({ seed: 'demo' }))
    assert.equal(
      ((await createdRes.json()) as { snapshot: { human_approved: boolean } }).snapshot
        .human_approved,
      false,
    )

    const { POST: endorse } = endorseRoute('codes')
    const ok = await endorse(
      jsonReq('POST', { expectedVersion: 1 }),
      ctx({ seed: 'demo', id: 'C-distrust' }),
    )
    assert.equal(ok.status, 200)
    assert.equal(((await ok.json()) as { human_approved: boolean }).human_approved, true)

    const stale = await endorse(
      jsonReq('POST', { expectedVersion: 1 }),
      ctx({ seed: 'demo', id: 'C-distrust' }),
    )
    assert.equal(stale.status, 409)
    assert.equal(((await stale.json()) as { error: string }).error, 'CONFLICT')
  })

  it('reject archives an artifact (200)', async () => {
    const { POST: create } = collectionRoute('themes')
    await create(jsonReq('POST', { name: 'Control', summary: 's' }), ctx({ seed: 'demo' }))
    const { POST: reject } = rejectRoute('themes')
    const res = await reject(
      jsonReq('POST', { note: 'dupe' }),
      ctx({ seed: 'demo', id: 'T-control' }),
    )
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { archived: boolean }).archived, true)
  })

  it('an unknown collection segment is a developer error (throws at construction)', () => {
    assert.throws(() => collectionRoute('widgets'))
  })
})
