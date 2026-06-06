import { existsSync, lstatSync, readdirSync } from 'node:fs'
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
  symlinks_skipped?: string[]
  items: IngestItem[]
}

/**
 * Walk a folder collecting candidate files. Uses `lstatSync` (NOT `statSync`)
 * so symlinks are NOT followed (#212). A tarball whose subdir is a symlink to
 * `~/.ssh` or `/var/log` would otherwise silently enqueue and ingest every
 * file under the destination.
 *
 * Symlinks encountered during the walk are skipped and returned alongside the
 * file list so the caller can surface them (rather than silently dropping
 * them, which is its own bug). The top-level target IS allowed to be a
 * symlink — the user typed it on purpose; we just don't traverse INTO
 * unexpected destinations.
 */
function walk(path: string): { files: string[]; symlinksSkipped: string[] } {
  // Top-level: use statSync so the user CAN pass an explicit symlink path.
  // The classify() pass later still uses lstatSync to refuse symlinked files.
  const topStat = lstatSync(path)
  if (topStat.isFile() || topStat.isSymbolicLink()) {
    return { files: [path], symlinksSkipped: [] }
  }
  const files: string[] = []
  const symlinksSkipped: string[] = []
  const recur = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue
      const abs = join(dir, entry)
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) {
        symlinksSkipped.push(abs)
        continue
      }
      if (st.isDirectory()) {
        recur(abs)
      } else if (st.isFile()) {
        files.push(abs)
      }
      // other types (sockets, fifos, devices) are intentionally ignored
    }
  }
  recur(path)
  return { files, symlinksSkipped }
}

/**
 * Route a file or folder into the job queue. Folder ingest is resumable:
 * jobs are unique on (kind, source_path), so a re-run only enqueues new files.
 * Each newly-queued file emits an agent-authored `create` event.
 */
export function ingestPath(seedPath: string, target: string): IngestResult {
  if (!existsSync(target)) throw new CompostError('FILE_NOT_FOUND', `No such path: ${target}`)

  const { files, symlinksSkipped } = walk(target)
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

    const result: IngestResult = { seed: seedPath, queued, skipped, unsupported, items }
    if (symlinksSkipped.length > 0) result.symlinks_skipped = symlinksSkipped
    return result
  } finally {
    queue.close()
    events.close()
  }
}
