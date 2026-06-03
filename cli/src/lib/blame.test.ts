import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { CompostError } from '../errors.js'
import { blame } from './blame.js'
import { initSeed } from './seed.js'

const EVENTS_TABLE_SQL = `
CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  action        TEXT NOT NULL,
  actor_type    TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  agent_name    TEXT,
  agent_version TEXT,
  prompt_hash   TEXT,
  model         TEXT,
  payload       TEXT NOT NULL,
  parent_event  TEXT REFERENCES events(id),
  batch_id      TEXT
);
CREATE INDEX idx_events_artifact ON events(artifact_kind, artifact_id);
CREATE INDEX idx_events_ts ON events(ts);
`

interface SeededEvent {
  id?: string
  ts?: string
  artifact_kind?: string
  artifact_id?: string
  action?: string
  actor_type?: 'researcher' | 'agent' | 'ai'
  actor_id?: string
  agent_name?: string
  agent_version?: string
  prompt_hash?: string
  model?: string
  payload?: unknown
  parent_event?: string | null
}

let counter = 0
function ulid(): string {
  counter += 1
  return ('01JM9NPC' + counter.toString(36).toUpperCase().padStart(18, '0')).slice(0, 26)
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function seedEvents(dbPath: string, events: SeededEvent[]): string[] {
  const db = new Database(dbPath)
  try {
    db.exec(EVENTS_TABLE_SQL)
    const stmt = db.prepare(`
      INSERT INTO events (id, ts, artifact_kind, artifact_id, action, actor_type, actor_id,
        agent_name, agent_version, prompt_hash, model, payload, parent_event, batch_id)
      VALUES (@id, @ts, @artifact_kind, @artifact_id, @action, @actor_type, @actor_id,
        @agent_name, @agent_version, @prompt_hash, @model, @payload, @parent_event, @batch_id)
    `)
    const ids: string[] = []
    for (const e of events) {
      const id = e.id ?? ulid()
      stmt.run({
        id,
        ts: e.ts ?? new Date(1700000000000 + ids.length * 1000).toISOString(),
        artifact_kind: e.artifact_kind ?? 'highlight',
        artifact_id: e.artifact_id ?? sha('default'),
        action: e.action ?? 'create',
        actor_type: e.actor_type ?? 'researcher',
        actor_id: e.actor_id ?? 'juan',
        agent_name: e.agent_name ?? null,
        agent_version: e.agent_version ?? null,
        prompt_hash: e.prompt_hash ?? null,
        model: e.model ?? null,
        payload: JSON.stringify(e.payload ?? {}),
        parent_event: e.parent_event ?? null,
        batch_id: null,
      })
      ids.push(id)
    }
    return ids
  } finally {
    db.close()
  }
}

describe('blame', () => {
  let work: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-blame-'))
    counter = 0
  })

  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('errors when the seed has no events.sqlite', () => {
    initSeed('demo', { cwd: work })
    assert.throws(() => blame(sha('any'), { cwd: work }), CompostError)
  })

  it('returns events in chronological order for a full SHA256 ref', () => {
    const { path } = initSeed('demo', { cwd: work })
    const artifactId = sha('hl-1')
    const eventsPath = join(path, '.compost', 'events.sqlite')
    seedEvents(eventsPath, [
      { artifact_id: artifactId, action: 'create' },
      {
        artifact_id: artifactId,
        action: 'update',
        actor_id: 'juan',
        payload: { field: 'text', after: 'edited' },
      },
      {
        artifact_id: artifactId,
        action: 'endorse',
        actor_type: 'researcher',
        actor_id: 'juan',
      },
    ])
    const result = blame(artifactId, { cwd: work })
    assert.equal(result.events.length, 3)
    assert.equal(result.events[0]?.action, 'create')
    assert.equal(result.events[1]?.action, 'update')
    assert.equal(result.events[2]?.action, 'endorse')
    assert.equal(result.resolved_artifact_id, artifactId)
  })

  it('accepts an 8-char SHA256 prefix', () => {
    const { path } = initSeed('demo', { cwd: work })
    const artifactId = sha('hl-prefix')
    seedEvents(join(path, '.compost', 'events.sqlite'), [
      { artifact_id: artifactId, action: 'create' },
    ])
    const result = blame(artifactId.slice(0, 12), { cwd: work })
    assert.equal(result.resolved_artifact_id, artifactId)
  })

  it('rejects ambiguous prefixes', () => {
    const { path } = initSeed('demo', { cwd: work })
    // Both IDs start with the same first 8 hex chars.
    const idA = 'cafebabe' + sha('a').slice(8)
    const idB = 'cafebabe' + sha('b').slice(8)
    seedEvents(join(path, '.compost', 'events.sqlite'), [
      { artifact_id: idA, action: 'create' },
      { artifact_id: idB, action: 'create' },
    ])
    assert.throws(() => blame('cafebabe', { cwd: work }), /ambiguous/i)
  })

  it('rejects malformed refs', () => {
    const { path } = initSeed('demo', { cwd: work })
    seedEvents(join(path, '.compost', 'events.sqlite'), [{ action: 'create' }])
    assert.throws(() => blame('too-short', { cwd: work }), CompostError)
    assert.throws(() => blame('xyzpqrstuv', { cwd: work }), CompostError)
  })

  it('resolves `latest:<kind>=<seed>` to the most recent create of that kind', () => {
    const { path } = initSeed('demo', { cwd: work })
    const oldId = sha('hl-old')
    const newId = sha('hl-new')
    seedEvents(join(path, '.compost', 'events.sqlite'), [
      {
        artifact_id: oldId,
        action: 'create',
        artifact_kind: 'highlight',
        ts: '2026-06-01T00:00:00Z',
      },
      {
        artifact_id: newId,
        action: 'create',
        artifact_kind: 'highlight',
        ts: '2026-06-02T00:00:00Z',
      },
    ])
    const result = blame('latest:highlight=demo', { cwd: work })
    assert.equal(result.resolved_artifact_id, newId)
  })

  it('throws when only one seed exists is required but multiple are present', () => {
    initSeed('alpha', { cwd: work })
    initSeed('beta', { cwd: work })
    assert.throws(() => blame(sha('any'), { cwd: work }), /Multiple seeds/i)
  })

  it('preserves AI actor metadata (model, prompt_hash) in event payload', () => {
    const { path } = initSeed('demo', { cwd: work })
    const artifactId = sha('hl-ai')
    const promptHash = sha('prompt')
    seedEvents(join(path, '.compost', 'events.sqlite'), [
      {
        artifact_id: artifactId,
        action: 'create',
        actor_type: 'ai',
        actor_id: 'anthropic:claude',
        model: 'anthropic:claude',
        prompt_hash: promptHash,
        payload: { suggestion: 'tag X' },
      },
    ])
    const result = blame(artifactId, { cwd: work })
    const evt = result.events[0]
    assert.ok(evt)
    assert.equal(evt.actor_type, 'ai')
    assert.equal(evt.model, 'anthropic:claude')
    assert.equal(evt.prompt_hash, promptHash)
  })
})
