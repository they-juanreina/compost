import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { provisionNativeVenv } from '../lib/provisionNative.js'
import { runSetup } from '../lib/setup.js'
import { runSetupWizard, type WizardIO } from '../lib/setupWizard.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { registerSetupItem } from './setupItem.js'

interface SetupFlags {
  provisionNative?: boolean
  pythonBin?: string
  transcriberDir?: string
  check?: boolean
}

/** Terminal IO for the wizard: readline prompts, with echo muted for secrets. */
function terminalIO(): { io: WizardIO; close: () => void } {
  let muted = false
  const mutable = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      if (!muted) process.stdout.write(chunk)
      cb()
    },
  })
  const rl = createInterface({ input: process.stdin, output: mutable, terminal: true })
  const io: WizardIO = {
    say: (text) => process.stdout.write(`${text}\n`),
    ask: async (question, def) => {
      const suffix = def !== undefined ? ` [${def}]` : ''
      const answer = (await rl.question(`${question}${suffix}: `)).trim()
      return answer === '' && def !== undefined ? def : answer
    },
    confirm: async (question, def) => {
      const hint = def ? 'Y/n' : 'y/N'
      const answer = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase()
      if (answer === '') return def
      return answer === 'y' || answer === 'yes'
    },
    askHidden: async (question) => {
      process.stdout.write(question)
      muted = true
      try {
        const answer = await rl.question('')
        process.stdout.write('\n')
        return answer
      } finally {
        muted = false
      }
    },
  }
  return { io, close: () => rl.close() }
}

/** Seed dirs under <cwd>/Seeds that already have a config.toml. */
function existingSeeds(cwd: string): string[] {
  const root = resolve(cwd, 'Seeds')
  if (!existsSync(root)) return []
  try {
    return readdirSync(root)
      .filter((e) => !e.startsWith('.'))
      .map((e) => join(root, e))
      .filter((p) => statSync(p).isDirectory() && existsSync(join(p, '.compost', 'config.toml')))
  } catch {
    return []
  }
}

export function registerSetup(program: Command): void {
  const setup = program
    .command('setup')
    .description(
      'Guided setup at a terminal (checks + confirmed fixes + tokens + chat model); a read-only JSON health report when piped, with --json, or with --check',
    )
    .option('--check', 'Read-only diagnostic report (skip the guided wizard at a TTY)')
    .option(
      '--provision-native',
      'Provision the native transcription venv (parakeet-mlx + pyannote + silero) on Apple Silicon, then re-check',
    )
    .option(
      '--python-bin <path>',
      'Interpreter to build the native venv from (with --provision-native)',
    )
    .option(
      '--transcriber-dir <path>',
      'transcriber/ package dir (with --provision-native; else COMPOST_TRANSCRIBER_DIR or auto-discovered)',
    )
    .action(async (flags: SetupFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        // Guided wizard: only at an interactive terminal, only when the human
        // asked for nothing more specific. Agents/CI (no TTY or --json) and
        // explicit --check / --provision-native keep the deterministic paths.
        const interactive =
          out.human &&
          process.stdin.isTTY === true &&
          process.stdout.isTTY === true &&
          flags.check !== true &&
          flags.provisionNative !== true
        if (interactive) {
          const { io, close } = terminalIO()
          try {
            const result = await runSetupWizard({
              io,
              cwd: process.cwd(),
              run: (c, args) => ({
                ok: spawnSync(c, args, { stdio: 'inherit' }).status === 0,
              }),
              listSeeds: () => existingSeeds(process.cwd()),
            })
            if (!result.report.ready) process.exitCode = 1
          } finally {
            close()
          }
          return
        }

        let provision: ReturnType<typeof provisionNativeVenv> | undefined
        if (flags.provisionNative) {
          if (out.human)
            process.stderr.write(
              'Provisioning native transcription venv (downloads ~GB of ML wheels — a few minutes)…\n',
            )
          provision = provisionNativeVenv({
            ...(flags.pythonBin !== undefined ? { pythonBin: flags.pythonBin } : {}),
            ...(flags.transcriberDir !== undefined ? { transcriberDir: flags.transcriberDir } : {}),
          })
        }
        // The doctor runs after provisioning, so the report reflects the new venv.
        const report = await runSetup({ cwd: process.cwd() })
        emit({ command: 'setup', ...(provision ? { provision } : {}), ...report }, out)
        // Non-zero exit when any check failed, so CI / scripts can gate on it.
        if (!report.ready) process.exitCode = 1
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  // Per-item maintenance lives on its own `setup item …` JSON envelope, so the
  // read-only `compost setup` report above stays byte-for-byte unchanged.
  registerSetupItem(setup)
}
