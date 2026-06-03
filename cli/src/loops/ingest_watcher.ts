import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import { classify } from '../lib/dispatch.js'
import { emitAgentCreate, openSeedEvents } from '../lib/events.js'
import { JobQueue, stateDbPath } from '../lib/queue.js'

const AGENT_NAME = 'ingest-watcher'
const AGENT_VERSION = '0.1.0'

export interface WatcherProcessResult {
  moved: Array<{ from: string; to: string; session_id: string; job_id: number }>
  unsupported: string[]
}

function nextSessionId(sessionsDir: string): string {
  const existing = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).filter((e) => /^S\d+$/.test(e))
    : []
  const max = existing.reduce((m, e) => Math.max(m, Number(e.slice(1))), 0)
  return `S${String(max + 1).padStart(3, '0')}`
}

/**
 * Process everything currently in a seed's sessions/_inbox/: assign a session
 * id, move the file to sessions/<sid>/source.<ext> atomically, enqueue a job,
 * and emit an agent `create` event. Pure of timers — call it on boot (replay)
 * and from the debounced live watcher. Idempotent: an empty inbox is a no-op.
 */
export function processInbox(seedPath: string): WatcherProcessResult {
  const sessionsDir = join(seedPath, 'sessions')
  const inbox = join(sessionsDir, '_inbox')
  const result: WatcherProcessResult = { moved: [], unsupported: [] }
  if (!existsSync(inbox)) return result

  const queue = new JobQueue(stateDbPath(seedPath))
  const events = openSeedEvents(seedPath)
  try {
    for (const entry of readdirSync(inbox)) {
      if (entry.startsWith('.')) continue
      const from = join(inbox, entry)
      if (!statSync(from).isFile()) continue
      const d = classify(from)
      if (d === null) {
        result.unsupported.push(from)
        continue
      }
      const sid = nextSessionId(sessionsDir)
      const sessionDir = join(sessionsDir, sid)
      mkdirSync(sessionDir, { recursive: true })
      const to = join(sessionDir, `source${extname(entry).toLowerCase()}`)
      renameSync(from, to) // atomic within the same filesystem
      const { id } = queue.enqueue(d.kind, to, {
        category: d.category,
        session_id: sid,
        original_name: basename(entry),
      })
      emitAgentCreate(events, {
        artifactKind: 'session',
        initialState: { session_id: sid, source: to, kind: d.kind },
        agentName: AGENT_NAME,
        agentVersion: AGENT_VERSION,
      })
      result.moved.push({ from, to, session_id: sid, job_id: id })
    }
    return result
  } finally {
    queue.close()
    events.close()
  }
}
