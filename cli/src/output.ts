import type { Command } from 'commander'

import { isCompostError } from './errors.js'

export interface OutputOptions {
  human: boolean
}

export function getOutputOpts(cmd: Command): OutputOptions {
  let root: Command = cmd
  while (root.parent) root = root.parent
  const opts = root.opts() as { human?: boolean }
  return { human: opts.human === true }
}

export function emit(data: unknown, opts: OutputOptions): void {
  const text = opts.human ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  process.stdout.write(`${text}\n`)
}

export function emitError(err: unknown, opts: OutputOptions): never {
  const compost = isCompostError(err)
  const code = compost ? err.code : 'INTERNAL'
  const message = err instanceof Error ? err.message : String(err)

  if (opts.human) {
    process.stderr.write(`error: ${message}\n`)
    process.stderr.write(`code: ${code}\n`)
  } else {
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`)
  }

  process.exit(1)
}
