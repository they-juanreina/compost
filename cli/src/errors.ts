export type CompostErrorCode =
  | 'NOT_IMPLEMENTED'
  | 'NOT_IN_SEED'
  | 'INVALID_INPUT'
  | 'FILE_NOT_FOUND'
  | 'IO_ERROR'
  | 'CONFIG_ERROR'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_AUTH'
  | 'SCHEMA_VIOLATION'
  | 'INTERNAL'

export class CompostError extends Error {
  public readonly code: CompostErrorCode

  constructor(code: CompostErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'CompostError'
    this.code = code
  }
}

export function isCompostError(value: unknown): value is CompostError {
  return value instanceof CompostError
}
