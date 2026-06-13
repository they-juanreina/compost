# Compost — SwiftUI native spike

A **throwaway viability spike**, not a product. It walks through the door
[ADR 0003](../docs/adr/0003-interfaces-monorepo-plugin-tauri.md) §4 left open:

> a future *truly* native app … replaces only the rendering shell; it would read
> the event log directly and dispatch mutations through the engine or CLI.

The question it answers cheaply: **is a native shell over the compost engine
contract viable and pleasant enough to justify revisiting ADR 0003's Tauri-first
default?** It does *not* reimplement engine logic — every mutation goes through
the `compost` CLI so three-actor provenance stays honest.

## The slice (reader/coder round-trip)

Render a real session transcript natively → click an utterance → create a
Highlight via the engine → watch it appear in `events.sqlite` (reduced in Swift)
and as `highlights/H-NNN.md`.

## How it talks to the engine

| Concern | Mechanism |
|---|---|
| Transcript | `transcript.json` decoded directly (`Models/Transcript.swift`) — canonical on-disk JSON, no CLI hop |
| Highlights / provenance | `.compost/events.sqlite` opened **read-only** and reduced in Swift (`Engine/EventLog.swift` + `Engine/EventReducer.swift`, a verbatim port of `provenance/src/reducer.ts`) |
| Writes (create highlight) | `compost create highlight … --json` spawned as a subprocess (`Engine/CompostCLI.swift`); researcher author, atomic md+event |

The app **never** writes to `events.sqlite`. WAL mode lets the read handle
coexist with a running `compost watch`.

## Layout

```
Sources/
  CompostKit/        pure, testable: models + reducer + sqlite reader + CLI wrapper
  CompostSpike/      the SwiftUI macOS app (rendering shell only)
  Probe/             headless end-to-end check of the engine boundary
Tests/
  CompostKitTests/   reducer golden tests (pinned to reducer.ts)
```

## Run it

Prereqs: macOS on Apple Silicon, Swift 6 / Xcode 16+, the compost CLI available
(either `npm i -g @they-juanreina/compost-cli`, or `pnpm build` at the repo root),
and a seed to read. The default seed is the readiness workspace at
`~/compost-readiness` (`audio-probe/S001`).

```sh
# Default: use `compost` on PATH. To pin the *repo* build instead, point
# COMPOST_CLI at the runnable entry — cli/bin/compost.js (NOT dist/index.js,
# which only exports run() and emits nothing when run directly).
export COMPOST_CLI=/Users/<you>/compost/cli/bin/compost.js

# 1. Headless engine-boundary check (read-only)
swift run --package-path native Probe

#    …and the write round-trip (appends one researcher highlight to the seed)
swift run --package-path native Probe --create

# 2. Reducer fidelity tests
swift test --package-path native

# 3. The GUI
swift run --package-path native CompostSpike
```

Overrides (all optional): `COMPOST_WORKSPACE` (default `~/compost-readiness`),
`COMPOST_SEED` (default `audio-probe`), `COMPOST_SESSION` (default `S001`),
`COMPOST_CLI` (default `compost` on PATH).

## What this spike does NOT do

No retrieval/embeddings UI; no saturation/agreement; no codebook/category
management; **no write reimplementation**; no `compost serve`; no iOS; no
sandbox/notarization hardening; no keychain; no `--ai` actor path; no audio
capture (that's the deferred capture-first spike).

## What a green run tells us

- The native shell can read the event log and **reduce it faithfully** (tests +
  the probe's blame cross-check).
- A highlight created in-app is honest provenance: it lands as both `H-NNN.md`
  and a `create/highlight/researcher` event, `human_approved == true`.
- Spawning the node CLI from a Swift process works (the #1 risk).

If those hold and the reader *feels* good, that's evidence to **revisit** ADR
0003 — against the engine contract, exactly as §4 describes. If the CLI-spawn or
reducer port is painful, ADR 0003 stands and we've spent very little to learn it.

> Distribution caveat (out of scope): a sandboxed/notarized bundle can't freely
> spawn an external node CLI. Productionizing the write path likely means either
> bundling node or implementing `compost serve` (the iOS-reusable option). The
> spike pins `COMPOST_CLI` to sidestep this deliberately.
