/**
 * Contract test (#148): validates that the JSON body the Node-side
 * `TranscriberClient.transcribe()` emits matches the request shape Python's
 * pydantic `TranscribeRequest` model accepts.
 *
 * The contract schema is committed at `cli/contracts/transcribe-request.schema.json`.
 * Regenerate via `python -m transcriber.scripts.export_contracts` when the
 * pydantic model changes.
 *
 * This test catches the bug class that #148 exemplified: the client sending
 * `{audio_path, session_id}` while the route required
 * `{seed_path, session_id, source_path}`. Pure unit test in Node — no
 * subprocess, no Python at test time.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import { Ajv2020 } from 'ajv/dist/2020.js'

import { TranscriberClient } from './transcriber_client.js'

const CONTRACT_PATH = resolve(
  import.meta.dirname,
  '..',
  'contracts',
  'transcribe-request.schema.json',
)

interface CapturedRequest {
  body: unknown
  headers?: Record<string, string>
}

/** Capture the body the client tries to send without actually making an HTTP call. */
function captureBody(): { capture: CapturedRequest; fetchImpl: typeof fetch } {
  const capture: CapturedRequest = { body: undefined }
  const fetchImpl = (async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    capture.body = JSON.parse(String(init?.body ?? '{}'))
    return new Response(
      JSON.stringify({ session_id: 'S001', transcript_path: '/x', status: 'ok' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return { capture, fetchImpl }
}

describe('TranscriberClient → /transcribe contract', () => {
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as Record<string, unknown>
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  const validate = ajv.compile(contract)

  it('emits a body that conforms to the pydantic TranscribeRequest schema', async () => {
    const { capture, fetchImpl } = captureBody()
    const client = new TranscriberClient({ fetchImpl })
    await client.transcribe('/seeds/demo/sessions/S001/source.mp3', 'S001', '/seeds/demo', 'en')

    const ok = validate(capture.body)
    assert.equal(
      ok,
      true,
      `Body failed contract validation: ${JSON.stringify(validate.errors, null, 2)}`,
    )
  })

  it('includes the three required fields the route expects', async () => {
    const { capture, fetchImpl } = captureBody()
    const client = new TranscriberClient({ fetchImpl })
    await client.transcribe('/x/source.mp3', 'S007', '/seeds/x')

    const body = capture.body as Record<string, unknown>
    assert.equal(body.seed_path, '/seeds/x')
    assert.equal(body.session_id, 'S007')
    assert.equal(body.source_path, '/x/source.mp3')
  })

  it('omits language when not provided (route default applies)', async () => {
    const { capture, fetchImpl } = captureBody()
    const client = new TranscriberClient({ fetchImpl })
    await client.transcribe('/x/source.mp3', 'S007', '/seeds/x')

    const body = capture.body as Record<string, unknown>
    assert.ok(!('language' in body), 'language key should be absent when not specified')
  })

  it('forwards a language hint when given', async () => {
    const { capture, fetchImpl } = captureBody()
    const client = new TranscriberClient({ fetchImpl })
    await client.transcribe('/x/source.mp3', 'S007', '/seeds/x', 'es-CO')

    const body = capture.body as Record<string, unknown>
    assert.equal(body.language, 'es-CO')
  })

  it('rejects a session_id that violates the route pattern (sanity)', () => {
    // The contract enforces `^[A-Za-z0-9_-]+$` on session_id. The client doesn't
    // pre-validate (route does), but a malformed value should fail the schema
    // when we sanity-check the captured body.
    const body = {
      seed_path: '/seeds/demo',
      session_id: '../etc/passwd',
      source_path: '/x/source.mp3',
    }
    const ok = validate(body)
    assert.equal(ok, false, 'path-traversal session_id must fail the contract')
  })
})
