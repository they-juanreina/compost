import { buildProgram } from './router.js'

export async function run(argv: readonly string[] = process.argv): Promise<void> {
  const program = buildProgram()
  await program.parseAsync(argv as string[])
}
