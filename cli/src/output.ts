import type { Command } from 'commander'

import { errMessage, isCompostError } from './errors.js'
import { redactSecrets } from './lib/redact.js'

export interface OutputOptions {
  human: boolean
}

/**
 * Resolve the output mode (#173). Explicit flags win: `--json` → machine,
 * `--human` → readable. With neither, auto-detect: a TTY (a researcher at a
 * terminal) gets human output; a pipe/redirect/MCP spawn (no TTY) gets JSON, so
 * the agent path is unaffected.
 */
export function getOutputOpts(cmd: Command): OutputOptions {
  let root: Command = cmd
  while (root.parent) root = root.parent
  const opts = root.opts() as { human?: boolean; json?: boolean }
  if (opts.json === true) return { human: false }
  if (opts.human === true) return { human: true }
  return { human: process.stdout.isTTY === true }
}

/**
 * Emit a result. In human mode, if a `render` function is provided it prints a
 * readable summary; otherwise (and for any command without a renderer) it
 * pretty-prints the JSON. Machine mode always prints compact JSON — unchanged,
 * so the MCP/agent path is byte-for-byte identical.
 */
export function emit(data: unknown, opts: OutputOptions, render?: (data: never) => string): void {
  if (opts.human && render !== undefined) {
    process.stdout.write(`${render(data as never)}\n`)
    return
  }
  const text = opts.human ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  process.stdout.write(`${text}\n`)
}

export function emitError(err: unknown, opts: OutputOptions): never {
  const code = isCompostError(err) ? err.code : 'INTERNAL'
  // Mask any secret that reached the error message (defense-in-depth, #236).
  const message = redactSecrets(errMessage(err))

  if (opts.human) {
    process.stderr.write(`error: ${message}\n`)
    process.stderr.write(`code: ${code}\n`)
  } else {
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`)
  }

  process.exit(1)
}
