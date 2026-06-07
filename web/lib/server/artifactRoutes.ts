/**
 * Route-handler factories for the artifact CRUD families (#121). Each per-kind
 * `route.ts` is a thin `export const { GET, POST } = collectionRoute('highlights')`
 * so the list/create/get/update/reject/endorse logic lives (and is tested) once.
 * All handlers run on the Node.js runtime — the engine uses better-sqlite3,
 * which cannot run on edge (see each route file's `export const runtime`).
 */
import {
  createArtifact,
  endorse,
  getArtifactByRef,
  kindFromSegment,
  listArtifactsOfKind,
  reject,
  update,
} from '../actions.js'
import { parseActor, researcherId } from './actor.js'
import { ApiError, jsonOk, readJson, route } from './http.js'

type SeedCtx = { params: Promise<{ seed: string }> }
type SeedItemCtx = { params: Promise<{ seed: string; id: string }> }

/** Optimistic-lock version from `If-Match` header or a body `expectedVersion`. */
function expectedVersion(req: Request, body?: Record<string, unknown>): number | undefined {
  const header = req.headers.get('if-match')
  if (header !== null && header.trim() !== '') {
    const n = Number.parseInt(header, 10)
    if (Number.isNaN(n)) throw new ApiError('INVALID_INPUT', 'If-Match must be an integer version')
    return n
  }
  if (body !== undefined && body.expectedVersion !== undefined) {
    const v = body.expectedVersion
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new ApiError('SCHEMA_ERROR', 'expectedVersion must be an integer')
    }
    return v
  }
  return undefined
}

/** GET (list) + POST (create) for an artifact collection. */
export function collectionRoute(segment: string) {
  const kind = kindFromSegment(segment)
  return {
    GET: route<SeedCtx>(async (req, ctx) => {
      const { seed } = await ctx.params
      const includeArchived = new URL(req.url).searchParams.get('archived') === '1'
      return jsonOk(listArtifactsOfKind(seed, kind, { includeArchived }))
    }),
    POST: route<SeedCtx>(async (req, ctx) => {
      const { seed } = await ctx.params
      const author = parseActor(req)
      const body = await readJson(req)
      return jsonOk(createArtifact(seed, kind, author, body), { status: 201 })
    }),
  }
}

/** GET (one) + PATCH (update) + DELETE (reject/archive) for a single artifact. */
export function itemRoute(segment: string) {
  const kind = kindFromSegment(segment)
  return {
    GET: route<SeedItemCtx>(async (_req, ctx) => {
      const { seed, id } = await ctx.params
      return jsonOk(getArtifactByRef(seed, kind, id))
    }),
    PATCH: route<SeedItemCtx>(async (req, ctx) => {
      const { seed, id } = await ctx.params
      const author = parseActor(req)
      const body = await readJson(req)
      const field = body.field
      if (typeof field !== 'string' || field.trim() === '') {
        throw new ApiError('SCHEMA_ERROR', 'PATCH body must include a string "field"')
      }
      if (!('after' in body)) {
        throw new ApiError('SCHEMA_ERROR', 'PATCH body must include "after"')
      }
      return jsonOk(
        update(
          seed,
          kind,
          id,
          author,
          { field, before: body.before, after: body.after },
          expectedVersion(req, body),
        ),
      )
    }),
    DELETE: route<SeedItemCtx>(async (req, ctx) => {
      const { seed, id } = await ctx.params
      const author = parseActor(req)
      const note = new URL(req.url).searchParams.get('note') ?? undefined
      const ev = expectedVersion(req)
      return jsonOk(
        reject(seed, kind, id, researcherId(author), {
          ...(ev !== undefined ? { expectedVersion: ev } : {}),
          ...(note !== undefined ? { note } : {}),
        }),
      )
    }),
  }
}

/** POST .../[id]/endorse — promote an AI/agent draft to endorsed. */
export function endorseRoute(segment: string) {
  const kind = kindFromSegment(segment)
  return {
    POST: route<SeedItemCtx>(async (req, ctx) => {
      const { seed, id } = await ctx.params
      const author = parseActor(req)
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
      return jsonOk(endorse(seed, kind, id, researcherId(author), expectedVersion(req, body)))
    }),
  }
}

/** POST .../[id]/reject — archive an artifact, optionally with a note. */
export function rejectRoute(segment: string) {
  const kind = kindFromSegment(segment)
  return {
    POST: route<SeedItemCtx>(async (req, ctx) => {
      const { seed, id } = await ctx.params
      const author = parseActor(req)
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
      const note = typeof body.note === 'string' ? body.note : undefined
      const ev = expectedVersion(req, body)
      return jsonOk(
        reject(seed, kind, id, researcherId(author), {
          ...(ev !== undefined ? { expectedVersion: ev } : {}),
          ...(note !== undefined ? { note } : {}),
        }),
      )
    }),
  }
}
