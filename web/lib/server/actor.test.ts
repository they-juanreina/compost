import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { parseActor } from './actor.js'
import { ApiError } from './http.js'

function req(actor?: string): Request {
  const headers = new Headers()
  if (actor !== undefined) headers.set('x-compost-actor', actor)
  return new Request('http://localhost/x', { headers })
}

describe('parseActor', () => {
  beforeEach(() => {
    process.env.COMPOST_USER = 'fallback@example.com'
  })
  afterEach(() => {
    delete process.env.COMPOST_USER
  })

  it('falls back to the OS user as a researcher when no header is present', () => {
    assert.deepEqual(parseActor(req()), {
      actorType: 'researcher',
      actorId: 'fallback@example.com',
    })
  })

  it('parses a structured researcher actor', () => {
    assert.deepEqual(parseActor(req('{"type":"researcher","id":"juan@example.com"}')), {
      actorType: 'researcher',
      actorId: 'juan@example.com',
    })
  })

  it('parses an AI actor with model + promptHash', () => {
    const a = parseActor(
      req('{"type":"ai","id":"claude:1","model":"anthropic:claude","promptHash":"abc"}'),
    )
    assert.equal(a.actorType, 'ai')
    assert.equal(a.model, 'anthropic:claude')
    assert.equal(a.promptHash, 'abc')
  })

  it('defaults a researcher id when only the type is given', () => {
    assert.equal(parseActor(req('{"type":"researcher"}')).actorId, 'fallback@example.com')
  })

  it('rejects malformed JSON', () => {
    assert.throws(
      () => parseActor(req('not json')),
      (e) => e instanceof ApiError && e.code === 'INVALID_INPUT',
    )
  })

  it('rejects the agent actor type (agents write via the CLI/loops)', () => {
    assert.throws(
      () => parseActor(req('{"type":"agent","id":"scanner@1"}')),
      (e) => e instanceof ApiError && e.code === 'INVALID_INPUT',
    )
  })

  it('requires an id for ai actors', () => {
    assert.throws(
      () => parseActor(req('{"type":"ai"}')),
      (e) => e instanceof ApiError && e.code === 'INVALID_INPUT',
    )
  })
})
