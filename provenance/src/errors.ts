export type ProvenanceErrorCode =
  | 'SCHEMA_VIOLATION'
  | 'IO_ERROR'
  | 'MIGRATION_FAILED'
  | 'DB_NOT_INITIALIZED'

export class ProvenanceError extends Error {
  public readonly code: ProvenanceErrorCode
  public readonly details: unknown

  constructor(
    code: ProvenanceErrorCode,
    message: string,
    options: { cause?: unknown; details?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ProvenanceError'
    this.code = code
    this.details = options.details
  }
}
