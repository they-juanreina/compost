import { CompostError } from '@they-juanreina/compost-cli/engine'

/**
 * Web API error envelope. Every error response is `{ error, message, details? }`
 * with a stable machine code in `error`, so the client can branch without
 * string-matching. Engine `CompostError`s are mapped to these; the web layer
 * adds `CONFLICT` (optimistic-lock failures) and `SCHEMA_ERROR` (bad request
 * body) that the engine has no notion of.
 */
export type ApiErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'SCHEMA_ERROR'
  | 'CONFLICT'
  | 'NO_INDEX'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL'

const STATUS: Record<ApiErrorCode, number> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  SCHEMA_ERROR: 422,
  CONFLICT: 409,
  // 409: chat needs a corpus/index that isn't built yet — a precondition the
  // caller can fix (`compost reindex --vectors`), not a server fault.
  NO_INDEX: 409,
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,
}

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly details: unknown
  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = STATUS[code]
    this.details = details
  }
}

/** Map an engine CompostError onto the web envelope + HTTP status. */
function fromCompostError(err: CompostError): ApiError {
  switch (err.code) {
    case 'NOT_IN_SEED':
    case 'FILE_NOT_FOUND':
      return new ApiError('NOT_FOUND', err.message)
    case 'SCHEMA_VIOLATION':
      return new ApiError('SCHEMA_ERROR', err.message)
    case 'INVALID_INPUT':
      return new ApiError('INVALID_INPUT', err.message)
    case 'NOT_IMPLEMENTED':
      return new ApiError('NOT_IMPLEMENTED', err.message)
    default:
      return new ApiError('INTERNAL', err.message)
  }
}

export interface JsonInit {
  status?: number
  /** Cache-Control header value. Defaults to `no-store` (researcher data is live). */
  cache?: string
}

/** JSON success response. Defaults to `no-store` — the filesystem is canonical
 * and a researcher may edit between requests. */
export function jsonOk(data: unknown, init: JsonInit = {}): Response {
  return Response.json(data, {
    status: init.status ?? 200,
    headers: { 'Cache-Control': init.cache ?? 'no-store' },
  })
}

function errorResponse(err: ApiError): Response {
  return Response.json(
    {
      error: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
    { status: err.status, headers: { 'Cache-Control': 'no-store' } },
  )
}

/**
 * Wrap a route handler so thrown ApiError / CompostError become the standard
 * envelope and anything else becomes a 500 INTERNAL (never leaking a stack to
 * the client). Returns a handler with the App Router (req, ctx) shape.
 */
export function route<Ctx>(
  handler: (req: Request, ctx: Ctx) => Promise<Response> | Response,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx)
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err)
      if (err instanceof CompostError) return errorResponse(fromCompostError(err))
      const message = err instanceof Error ? err.message : String(err)
      return errorResponse(new ApiError('INTERNAL', message))
    }
  }
}

/** Parse a JSON request body, raising SCHEMA_ERROR (not 500) on malformed JSON. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    throw new ApiError('SCHEMA_ERROR', 'Request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError('SCHEMA_ERROR', 'Request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}
