import { appendFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  [key: string]: unknown
}

export interface LogEntry extends LogFields {
  ts: string
  level: LogLevel
  msg: string
}

export class Logger {
  constructor(private readonly logFilePath: string | null) {}

  async log(level: LogLevel, msg: string, fields: LogFields = {}): Promise<void> {
    if (this.logFilePath === null) return
    const entry: LogEntry = { ts: new Date().toISOString(), level, msg, ...fields }
    try {
      await mkdir(dirname(this.logFilePath), { recursive: true })
      await appendFile(this.logFilePath, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      // Logging must never throw — the CLI keeps running even if logs are unwritable.
    }
  }

  debug(msg: string, fields?: LogFields): Promise<void> {
    return this.log('debug', msg, fields)
  }
  info(msg: string, fields?: LogFields): Promise<void> {
    return this.log('info', msg, fields)
  }
  warn(msg: string, fields?: LogFields): Promise<void> {
    return this.log('warn', msg, fields)
  }
  error(msg: string, fields?: LogFields): Promise<void> {
    return this.log('error', msg, fields)
  }
}

export async function findCompostRoot(start: string = process.cwd()): Promise<string | null> {
  let dir = start
  while (true) {
    try {
      const s = await stat(join(dir, '.compost'))
      if (s.isDirectory()) return dir
    } catch {
      // not found at this level
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function getLogPath(compostRoot: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  return join(compostRoot, '.compost', 'logs', `${date}.jsonl`)
}

export async function buildLogger(): Promise<Logger> {
  const root = await findCompostRoot()
  return new Logger(root === null ? null : getLogPath(root))
}
