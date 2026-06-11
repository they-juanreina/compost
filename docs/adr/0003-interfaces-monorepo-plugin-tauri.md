# ADR 0003: Interfaces — one monorepo, plugin-first, Tauri-wrap for native

- **Status:** Accepted
- **Date:** 2026-06-11
- **Deciders:** Juan (maintainer)
- **Confirms & sharpens:** [ROADMAP §"Interfaces"](../../ROADMAP.md#interfaces--cli--local-nextjs-web) ("Tauri-wrap into a desktop bundle later; not v1"), [docs/host-llm-routing.md](../host-llm-routing.md)
- **Related:** [audit report](../codebook-category-audit.md)

## Context

compost is maintained by one person, is expected to become his go-to agnostic research tool evolving across life/work phases, and is expected to be adopted by his team. The recurring question — re-opened while evaluating [ADR 0001](./0001-codebook-multiplicity.md)/[0002](./0002-category-tier.md) — is whether compost should stay "just the CLI" with a UI as a **separate project** (possibly a native macOS app) that consumes it.

What the codebase already establishes:

- **The engine is the product; every surface is a wrapper.** `@they-juanreina/compost-cli` exposes a public library API via its `./engine` subpath export (`cli/src/engine.ts`). The web package (`web/`) imports it **in-process** (`web/lib/actions.ts`) — reads via `better-sqlite3`, mutations dispatched through the same `createHighlight`/`createCode`/`endorseArtifact` functions the CLI uses. The MCP server (`plugin/mcp/server.ts`) shells out to the CLI as a subprocess. The plugin skills shell out too. Nothing re-implements logic.
- **The data layer is itself an integration contract.** Markdown/JSON on disk is canonical; `.compost/events.sqlite` is the append-only provenance log any process can read; derived state is rebuildable (`compost reindex`). A second program can *read* everything safely; *writes* must flow through the engine (or faithfully reproduce its event capture) to keep three-actor provenance honest.
- **House rule:** build the `compost <verb>` first, then wrap (plugin skills, MCP tools, UI actions).

## Decision

1. **Stay one monorepo.** `cli`, `web`, `plugin`, `provenance`, `retrieval`, `evals` remain workspace siblings with one version, one test suite, one migration story. No separate UI repository.
2. **The Claude plugin (skills + slash commands + MCP) is the primary UI for the current phase** — through the codebook/category data-model work and its dogfooding. It already exists, it exercises the verbs, and it is the surface teammates on Claude Code/Cowork adopt first.
3. **The native macOS (Apple Silicon) path is a Tauri-wrap of the existing `web/` package** — when the time comes, and not before the data model stabilizes. It is a packaging milestone, not a new product.
4. **The engine + events.sqlite + CLI contract is the extension seam.** A future *truly* native app (SwiftUI or otherwise) replaces only the rendering shell; it would read the event log directly and dispatch mutations through the engine or CLI. Nothing about this decision forecloses it.

## Why not a separate UI project now

- **Version skew during schema churn.** ADRs 0001/0002 add artifact kinds and thread `codebook_id` through creation, retrieval metadata, and (later) theme payloads. A second repo pinned to published `@they-juanreina/compost-*` packages would lag every schema change exactly when lockstep matters most.
- **Solo-maintainer arithmetic.** A second repo is a second issue tracker, release cadence, CI surface, and dependency dance. The monorepo gives the same modularity (workspace packages with explicit exports) without the coordination tax.
- **The boundary already exists where it matters.** "Separate project" buys isolation compost already has: the engine export *is* the API; the web package consumes it like an external client would, minus the friction.

## Why Tauri-wrap rather than SwiftUI for "native"

- One UI codebase (the Next.js app) serves browser (`compost serve`) and desktop bundle; a SwiftUI app forks every screen.
- Honest costs, stated up front: Tauri gives a WKWebView shell, not native AppKit idiom. And the web package's server-side reads (`better-sqlite3`) mean the wrap needs either a **Node sidecar process** (ship the Next server inside the bundle) or a **static export with mutations over the engine via IPC** — a real packaging spike, tracked as a work item, not hand-waved. Apple-Silicon-native performance is fine either way (the heavy lifting — embeddings, transcription — already lives in Ollama and the Python service, not the UI).
- If the desktop app someday needs what a webview can't give (system-wide capture, deep Finder integration, menu-bar ambient capture), *that* is the moment to revisit SwiftUI — against the engine contract, per decision §4.

## Consequences

- **Positive:** one migration story through the codebook/category churn; teammates adopt via the plugin with zero new infrastructure; `web/` continues maturing as v0.2 without architectural rework; native distribution stays a bounded packaging task.
- **Negative / accepted:** the desktop bundle inherits web-stack weight (Node sidecar or static-export rework); no native-idiom macOS UI in the foreseeable phase; the monorepo grows — mitigated by the existing package boundaries.
- **Revisit triggers:** a cloud/multi-machine deployment need (would force an HTTP boundary anyway), a second maintainer team owning UI exclusively, or webview-impossible native requirements.
