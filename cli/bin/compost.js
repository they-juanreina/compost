#!/usr/bin/env node
import { run } from '../dist/index.js'

run().catch((err) => {
  process.stderr.write(`compost: ${err?.message ?? String(err)}\n`)
  process.exit(1)
})
