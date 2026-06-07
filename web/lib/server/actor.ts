import { type Author, defaultResearcherId } from '@they-juanreina/compost-cli/engine'

import { ApiError } from './http.js'

/**
 * Resolve the acting identity for a mutation from the `x-compost-actor` request
 * header — the v0.2 stand-in for real auth on a single-researcher localhost
 * server (no login; the header is trusted because the server is local-only).
 *
 * Header is structured JSON `{ "type": "researcher"|"ai", "id": "...",
 * "model"?: "...", "promptHash"?: "..." }`, mapping 1:1 onto the provenance
 * Author. Absent → the OS user as a researcher (COMPOST_USER || USER ||
 * "researcher"), so the common case needs no header at all.
 *
 * `agent` is intentionally rejected: agent-authored events come from the
 * harness loops / CLI (emitAgentCreate), never an interactive web mutation.
 */
export function parseActor(req: Request): Author {
  const raw = req.headers.get('x-compost-actor')
  if (raw === null || raw.trim() === '') {
    return { actorType: 'researcher', actorId: defaultResearcherId() }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiError('INVALID_INPUT', 'x-compost-actor must be JSON {type,id,model?}')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ApiError('INVALID_INPUT', 'x-compost-actor must be a JSON object')
  }
  const p = parsed as Record<string, unknown>

  const type = p.type
  if (type !== 'researcher' && type !== 'ai') {
    throw new ApiError(
      'INVALID_INPUT',
      `x-compost-actor.type must be "researcher" or "ai" (got ${JSON.stringify(type)}); agent writes go through the CLI/loops`,
    )
  }

  const id =
    typeof p.id === 'string' && p.id.trim() !== ''
      ? p.id
      : type === 'researcher'
        ? defaultResearcherId()
        : undefined
  if (id === undefined) {
    throw new ApiError('INVALID_INPUT', 'x-compost-actor.id is required for ai actors')
  }

  const author: Author = { actorType: type, actorId: id }
  if (typeof p.model === 'string') author.model = p.model
  if (typeof p.promptHash === 'string') author.promptHash = p.promptHash
  return author
}

/** The researcher id for an endorse/reject (researcher-only actions). Uses the
 * actor's id whatever its declared type — the engine stamps actor_type. */
export function researcherId(author: Author): string {
  return author.actorId
}
