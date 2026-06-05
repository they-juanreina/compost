import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { provisionNativeVenv } from '../lib/provisionNative.js'
import { runSetup } from '../lib/setup.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface SetupFlags {
  provisionNative?: boolean
  pythonBin?: string
  transcriberDir?: string
}

export function registerSetup(program: Command): void {
  program
    .command('setup')
    .description(
      'Health-check prerequisites (Ollama, models, Docker, transcriber, HF token + pyannote license, Seeds/) and report fixes',
    )
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
}
