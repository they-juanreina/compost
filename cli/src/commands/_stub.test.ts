import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Command } from 'commander'
import { stubDescription } from './_stub.js'
import { registerQuery } from './query.js'
import { registerServe } from './serve.js'
import { registerSynthesize } from './synthesize.js'

describe('stub honesty (#161)', () => {
  it('stubDescription prefixes a not-implemented marker + issue ref', () => {
    assert.equal(stubDescription('Do a thing', 59), '[not implemented yet · #59] Do a thing')
    assert.equal(stubDescription('Do a thing'), '[not implemented yet] Do a thing')
  })

  it('every stub command is flagged as not-implemented in --help', () => {
    const program = new Command()
    registerQuery(program)
    registerSynthesize(program)
    registerServe(program)
    for (const name of ['query', 'synthesize', 'serve']) {
      const c = program.commands.find((x) => x.name() === name)
      assert.ok(c, `${name} should be registered`)
      assert.match((c as Command).description(), /^\[not implemented yet/)
    }
  })
})

describe('seed-scoped stubs accept --seed (#167)', () => {
  // Lands the flag contract before the action ships so multi-seed workspaces
  // can target a specific seed from the moment query/synthesize go live.
  const hasSeed = (program: Command, name: string): boolean => {
    const c = program.commands.find((x) => x.name() === name)
    assert.ok(c, `${name} should be registered`)
    return (c as Command).options.some((o) => o.long === '--seed')
  }

  it('query exposes --seed', () => {
    const program = new Command()
    registerQuery(program)
    assert.ok(hasSeed(program, 'query'), '--seed should be on query')
  })

  it('synthesize exposes --seed', () => {
    const program = new Command()
    registerSynthesize(program)
    assert.ok(hasSeed(program, 'synthesize'), '--seed should be on synthesize')
  })
})
