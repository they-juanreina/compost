# Spike: native macOS bundle via Tauri-wrap of `web/`

Status: **design note** · Date: 2026-06-12 · Issue: [#274](https://github.com/they-juanreina/compost/issues/274) · Decides against: [ADR 0003 §3](./adr/0003-interfaces-monorepo-plugin-tauri.md)

[ADR 0003](./adr/0003-interfaces-monorepo-plugin-tauri.md) fixed the native-macOS path as a **Tauri-wrap of the existing `web/` package**, not a SwiftUI fork, and named the one open question: packaging. `web/` does its data access server-side through native modules, so the wrap needs either a **Node sidecar** (ship the Next server in the bundle) or a **static export with mutations over the engine via IPC**. This note spikes both (plus Electron as the honest third option), measures them against what the codebase actually is today, and recommends one — leaving the *go/no-go* and the throwaway-PoC build to the maintainer, since "recommend one" is a production-shape decision, not a code change.

## What `web/` actually is (the constraint that decides this)

This is not a client-rendered SPA that happens to fetch JSON. The data layer is **server-only and native-module-bound**:

- Every API route pins `export const runtime = 'nodejs'` (`web/app/api/**/route.ts`) — there are ~16 of them (sessions, codes, highlights, themes, blame, endorse/reject, chat, agents).
- Reads go through `better-sqlite3` against `.compost/events.sqlite`; retrieval goes through `@lancedb/lancedb`. Both are `.node` native addons.
- `web/next.config.mjs` **externalizes** `better-sqlite3`, `@lancedb/lancedb`, and the three `@they-juanreina/compost-*` workspace packages: webpack emits `require(...)` and Node loads them natively at runtime. They are explicitly *never* bundled and *never* run on the edge runtime.
- Mutations route in-process through the CLI engine (`web/lib/actions.ts` → `@they-juanreina/compost-cli/engine`: `createCode`, `createHighlight`, `endorseArtifact`, …), so web-created artifacts are byte-identical to CLI-created ones, preserving three-actor provenance (ADR 0003 §"The data layer is itself an integration contract").

**Implication:** there is no version of this app where the UI talks only to a static file set. Both reads *and* writes require a live Node process with native addons compiled for the host arch (arm64). Any "static export" path must therefore stand up an engine-hosting process anyway — the only question is what speaks to it and over what boundary. That single fact does most of the work below.

## The three options

### A. Node sidecar — ship the Next standalone server inside the bundle

Tauri's [sidecar](https://v2.tauri.app/develop/sidecar/) mechanism bundles an external binary that the Rust shell spawns on launch. We ship `next build` in `output: 'standalone'` mode (a self-contained `server.js` + minimal `node_modules`) plus a Node runtime, bind it to `127.0.0.1:<random-port>`, and point the Tauri WKWebView at it. The webview is the existing app, unchanged.

- **Code reuse:** ~100%. The app, all 16 API routes, `lib/actions.ts`, and the engine in-process dispatch run exactly as under `compost serve`. Zero re-architecture.
- **Native modules:** `better-sqlite3` and `@lancedb/lancedb` load natively in the sidecar Node process — the same place they load today. Must be rebuilt/prebuilt for `aarch64-apple-darwin` and included in the sidecar payload.
- **Cost:** bundle a Node runtime (or compile to a single executable via `node --experimental-sea` / `pkg`-style tooling) + the standalone server + the two `.node` addons. Manage sidecar lifecycle (spawn on launch, health-check the port, kill on quit). Codesign/notarize the Node binary and addons.
- **Risk:** sidecar packaging of native `.node` files and a Node runtime is the fiddly part (codesigning each `.node`, hardened-runtime entitlements). But it is *packaging* fiddliness, not architectural risk — nothing about the app changes.

### B. Static export + mutations over IPC

`next build` with `output: 'export'` to emit static HTML/JS, rendered in the webview; data access moves to Tauri commands (Rust `#[tauri::command]`) invoked over Tauri's IPC, or to a thinner engine RPC.

- **Hard blocker:** `output: 'export'` **disallows API routes and server-only `runtime='nodejs'` code**. Every one of the 16 routes and all of `lib/actions.ts`/`lib/server/*` would have to be removed from the Next build and *reimplemented behind the IPC boundary*. But the engine and native addons are **Node/TypeScript**, not Rust — so a Tauri Rust command cannot call them directly. You would still need a Node host process to run `@they-juanreina/compost-cli/engine`, reached over IPC/stdio — i.e. you rebuild the sidecar from option A **and** rewrite every data path to call it. Strictly more work than A, for a thinner shell.
- **Code reuse:** UI components reuse; **all** data-access code is rewritten. Violates the house rule (the engine is the write path; don't reimplement) at the worst possible moment — mid–schema-churn (ADRs 0001/0002 still threading `codebook_id`).
- **Only upside:** a lighter-weight bundle if the engine could be reached without a Node host — which it can't, given native addons. So the upside doesn't materialize here.

### C. Electron — for completeness

Electron bundles Chromium + a Node main process; the engine runs in the main process, the app in the renderer. Node integration is the most frictionless of the three (it *is* Node). But it ships a full Chromium (~bundle weight an order larger than Tauri's WKWebView reuse), which is exactly the weight ADR 0003 chose Tauri to avoid. No reason to prefer it unless Tauri's WKWebView proves to lack a web feature the app needs (none identified).

## Comparison

| | A. Node sidecar | B. Static + IPC | C. Electron |
|---|---|---|---|
| Reuses 16 API routes + `lib/actions.ts` | ✅ as-is | ❌ rewrite all | ✅ (in main proc) |
| Needs a Node host for native addons | yes (sidecar) | **yes anyway** (IPC target) | yes (main proc) |
| Re-architecture during schema churn | none | large | small |
| Honors "engine is the write path" house rule | ✅ | ✗ (reimplements) | ✅ |
| Bundle weight | Node + 2 `.node` + WKWebView | lightest *in theory*, not in practice | + full Chromium |
| Where the fiddliness lives | codesigning sidecar/addons | rewriting + IPC + still a sidecar | mature, heaviest |

## Recommendation (maintainer to ratify)

**Option A — Node sidecar.** The deciding fact is that `web/` is server-runtime-and-native-addon bound by construction: both reads and writes need a live Node process with arm64 `.node` addons. Option B's promise (a thin static shell) collapses because the engine is Node, not Rust, so even "static export" must host the engine in a Node sidecar — making B *a superset* of A's work plus a full rewrite of the data layer, taken on during the exact schema churn ADR 0003 says to avoid. Option C buys frictionless Node at the cost of the Chromium weight ADR 0003 explicitly rejected.

Option A keeps the monorepo's core invariant intact — one UI codebase, the engine as the single write path — and reduces the native milestone to what ADR 0003 already called it: **a bounded packaging task**, not a product rework. The remaining work is genuinely just packaging: `output: 'standalone'`, prebuilt arm64 addons, sidecar lifecycle, codesign/notarize.

### Open questions for the maintainer

1. **Go/no-go + timing.** ADR 0003 gates this on the data model stabilizing (this milestone). Build the throwaway PoC now, or defer until #266/#269/#270/#275 land? (Recommend: defer the *PoC build* until the milestone closes; this note unblocks the decision.)
2. **Node-in-bundle strategy.** Single-executable (`node --experimental-sea`) vs. a vendored Node runtime alongside `server.js`. SEA is cleaner to codesign (one binary) but newer; vendored Node is boring and proven. (Lean: vendored Node for the PoC, revisit SEA for release.)
3. **Addon distribution.** Prebuilt `better-sqlite3`/`@lancedb/lancedb` for `aarch64-apple-darwin` pinned per release, or build-from-source in CI on an arm64 runner? (Lean: prebuilts pinned per release.)
4. **Scope of "read-only PoC."** The acceptance ("opens a seed read-only on Apple Silicon") only needs the read API routes + the SQLite addon. Ship the PoC with the LanceDB addon and mutation routes stubbed out, to shrink the first bundle? (Lean: yes — read-only PoC excludes lancedb + writes.)

### Out of scope for this note

The throwaway proof-of-concept bundle itself (ADR 0003 / #274 "no production commitment"). Building and notarizing a Tauri bundle needs the Rust + Tauri CLI toolchain and an Apple-Silicon signing identity on the maintainer's machine; it is a follow-up once the recommendation is ratified and the milestone closes. This PR delivers the **design note** the spike asked for; it does not commit production code.
