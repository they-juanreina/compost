/** Read all of stdin to a string — used for piped secret values (e.g. a token
 * fed via `printf %s "$TOKEN" | compost …`) so they never land in shell
 * history. Returns '' when stdin is an interactive TTY (nothing piped). */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
