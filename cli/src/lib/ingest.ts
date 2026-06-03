import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { CompostError } from '../errors.js'
import { classify } from './dispatch.js'
import { emitAgentCreate, openSeedEvents } from './events.js'
import { JobQueue, stateDbPath } from './queue.js'

const AGENT_NAME = 'ingest'
const AGENT_VERSION = '0.1.0'

export interface IngestItem {
  path: string
  kind: string
  category: string
  job_id: number
  queued: boolean
}

export interface IngestResult {
  seed: string
  queued: number
  skipped: number
  unsupported: string[]
  items: IngestItem[]
}

function walk(path: string): string[] {
  if (statSync(path).isFile()) return [path]
  const out: string[] = []
  for (const entry of readdirSync(path)) {
    if (entry.startsWith('.')) continue
    const abs = join(path, entry)
    if (statSync(abs).isDirectory()) out.push(...walk(abs))
    else out.push(abs)
  }
  return out
}

/**
 * Route a file or folder into the job queue. Folder ingest is resumable:
 * jobs are unique on (kind, source_path), so a re-run only enqueues new files.
 * Each newly-queued file emits an agent-authored `create` event.
 */
export function ingestPath(seedPath: string, target: string): IngestResult {
  if (!existsSync(target)) throw new CompostError('FILE_NOT_FOUND', `No such path: ${target}`)

  const files = walk(target)
  const queue = new JobQueue(stateDbPath(seedPath))
  const events = openSeedEvents(seedPath)
  try {
    const items: IngestItem[] = []
    const unsupported: string[] = []
    let queued = 0
    let skipped = 0

    for (const file of files) {
      const d = classify(file)
      if (d === null) {
        unsupported.push(file)
        continue
      }
      const { id, inserted } = queue.enqueue(d.kind, file, { category: d.category, ext: d.ext })
      if (inserted) {
        queued += 1
        emitAgentCreate(events, {
          artifactKind: 'ingest_job',
          initialState: { source_path: file, kind: d.kind, category: d.category },
          agentName: AGENT_NAME,
          agentVersion: AGENT_VERSION,
        })
      } else {
        skipped += 1
      }
      items.push({ path: file, kind: d.kind, category: d.category, job_id: id, queued: inserted })
    }

    return { seed: seedPath, queued, skipped, unsupported, items }
  } finally {
    queue.close()
    events.close()
  }
}
