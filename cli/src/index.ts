import { loadSecretsEnv } from './lib/secrets.js'
import { buildProgram } from './router.js'

export async function run(argv: readonly string[] = process.argv): Promise<void> {
  // Load ~/.compost/secrets.env into the environment so file-stored secrets
  // resolve everywhere an env var would (provider api_key_env, HUGGINGFACE_TOKEN,
  // the native transcriber subprocess) without editing a shell profile. Env vars
  // already set win; an insecure (group/world-readable) file is refused, not read.
  loadSecretsEnv({ warn: (msg) => process.stderr.write(`${msg}\n`) })
  const program = buildProgram()
  await program.parseAsync(argv as string[])
}
