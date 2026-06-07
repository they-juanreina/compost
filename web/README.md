# web

Next.js (App Router, shadcn) on `localhost:7860`. Annotation surface, chat-with-seed, provenance badges. Reads the seed filesystem + `.compost/events.sqlite` for speed; every mutation dispatches the CLI engine in-process.

See [ROADMAP.md § Interfaces](../ROADMAP.md#interfaces--cli--local-nextjs-web).

## v0.2 architecture decisions

The "Visual researcher coding surface" milestone is built on these choices (locked at the start so the UI sessions don't diverge):

- **Engine reuse — import the CLI engine in-process.** Every mutation goes through `@they-juanreina/compost-cli/engine` (the same `create*/endorse/reject/update` write+emit path the CLI uses), via `web/lib/actions.ts`. No write logic is reimplemented in `web/lib`; web- and CLI-created artifacts are identical in file + event shape. Reads fold the event log with the provenance reducer.
- **Node runtime only.** The engine depends on `better-sqlite3` (and retrieval on `@lancedb/lancedb`) — native modules that cannot run on the edge runtime. Every API route declares `export const runtime = 'nodejs'`, and these packages are listed in `serverExternalPackages` (never bundled). `next.config.mjs` also sets `resolve.extensionAlias` so NodeNext-style `.js` import specifiers resolve to their `.ts` sources under webpack.
- **Actor identity (v0.2 stand-in for auth).** `x-compost-actor` request header carries structured JSON `{type: researcher|ai, id, model?, promptHash?}`, parsed by `web/lib/server/actor.ts`; absent → the OS user as a researcher. Single-researcher localhost, no login — the header is trusted because the server is local-only. `agent` writes go through the CLI/loops, not the web.
- **Error envelope.** Every error response is `{error, message, details?}` with a stable code (`NOT_FOUND | INVALID_INPUT | SCHEMA_ERROR | CONFLICT | NOT_IMPLEMENTED | INTERNAL`). Engine `CompostError`s are mapped to these in `web/lib/server/http.ts`.
- **Optimistic concurrency.** Mutations accept an expected version via `If-Match` header or `expectedVersion` body field; a mismatch returns `409 CONFLICT` with the current snapshot so the client can reconcile.
- **Frontend stack (for the UI sessions, not yet installed):** **dnd-kit** (drag-drop), **@tanstack/react-virtual** (table + frame-strip virtualization), **shadcn/ui** on Tailwind. Added in the first UI session (transcript page) so the lockfile only carries what's used.

## API surface (Sessions 0–2)

- `GET /api/seeds/[seed]/sessions` — session list + counts
- `GET /api/seeds/[seed]/sessions/[session]` — transcript.json + derived frame index
- `GET /api/seeds/[seed]/sessions/[session]/frames/[id]` — frame image (traversal-safe)
- `GET|POST /api/seeds/[seed]/{highlights,codes,themes}` — list / create
- `GET|PATCH|DELETE /api/seeds/[seed]/{…}/[id]` — get / update / reject(archive)
- `POST /api/seeds/[seed]/{…}/[id]/{endorse,reject}` — lifecycle
