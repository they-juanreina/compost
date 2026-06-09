import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { JobQueue, MAX_ATTEMPTS } from './queue.js'

function burnAllAttempts(queue: JobQueue): void {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const job = queue.claim('transcribe')
    assert.ok(job, `claim #${i + 1} should succeed`)
    queue.fail(job.id, 'service unreachable')
  }
}

describe('JobQueue requeue (#239)', () => {
  it('a job that burned MAX_ATTEMPTS is failed and unclaimable', () => {
    const queue = new JobQueue(':memory:')
    queue.enqueue('transcribe', '/seed/sessions/S001/source.mp3', { session_id: 'S001' })
    burnAllAttempts(queue)
    assert.equal(queue.counts().failed, 1)
    assert.equal(queue.claim('transcribe'), null)
  })

  it('requeue resets failed jobs to queued with a fresh attempt budget', () => {
    const queue = new JobQueue(':memory:')
    const { id } = queue.enqueue('transcribe', '/seed/sessions/S001/source.mp3', {
      session_id: 'S001',
    })
    burnAllAttempts(queue)

    const requeued = queue.requeue()
    assert.equal(requeued.length, 1)
    assert.equal(requeued[0]?.id, id)
    assert.equal(requeued[0]?.status, 'queued')
    assert.equal(requeued[0]?.attempts, 0)
    // the last error stays on the row for triage until a retry overwrites it
    assert.equal(requeued[0]?.error, 'service unreachable')

    const claimed = queue.claim('transcribe')
    assert.equal(claimed?.id, id)
    assert.equal(claimed?.attempts, 1)
  })

  it('requeue by id leaves other failed jobs untouched; queued/done jobs are never requeued', () => {
    const queue = new JobQueue(':memory:')
    const a = queue.enqueue('transcribe', '/seed/a.mp3')
    queue.enqueue('transcribe', '/seed/b.mp3')
    const c = queue.enqueue('legacy-ingest', '/seed/c.pdf')
    // fail a and b terminally, complete c
    for (let i = 0; i < MAX_ATTEMPTS * 2; i++) {
      const job = queue.claim('transcribe')
      if (job === null) break
      queue.fail(job.id, 'boom')
    }
    const legacyJob = queue.claim('legacy-ingest')
    assert.ok(legacyJob)
    queue.complete(legacyJob.id)
    assert.deepEqual(queue.counts(), { queued: 0, running: 0, done: 1, failed: 2 })

    const requeued = queue.requeue(a.id)
    assert.deepEqual(
      requeued.map((j) => j.id),
      [a.id],
    )
    assert.deepEqual(queue.counts(), { queued: 1, running: 0, done: 1, failed: 1 })
    // done jobs stay done even on a blanket requeue
    queue.requeue()
    assert.equal(queue.list('done')[0]?.id, c.id)
    assert.equal(queue.counts().failed, 0)
  })

  it('requeue is a no-op on an empty or all-healthy queue', () => {
    const queue = new JobQueue(':memory:')
    assert.deepEqual(queue.requeue(), [])
    queue.enqueue('transcribe', '/seed/a.mp3')
    assert.deepEqual(queue.requeue(), [])
    assert.equal(queue.counts().queued, 1)
  })
})
