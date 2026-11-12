# ADR 0008: Keeping the door open for multiplayer — async multi-coder, merge-safe ledgers, no server

- **Status:** Accepted (direction and invariants); sync itself is **not** built
- **Date:** 2026-11-11
- **Deciders:** Juan (maintainer)
- **Related:** [ADR 0005](./0005-reference-key-and-rename-model.md) / #317
  (reference by `artifact_id`), [ADR 0006](./0006-ingest-provenance.md) (source
  sha256; transport out of core), [ADR 0007](./0007-visual-surface-rescope.md)
  (stateless review artifact, unsaved board layout),
  [tamper-evidence research](../provenance-tamper-evidence-research.md),
  `CLAUDE.md` §13 / §15

## Context

compost is single-user today: one researcher, one machine, one ledger. The team
wants to use it, and "multiplayer" could mean three different things:

1. **Read-only sharing** — one person codes; others receive endorsed evidence.
2. **Async multi-coder** — each researcher codes on their own machine and the
   ledgers are merged later.
3. **A shared live server** — several people on one hosted compost at once.

Qualitative method already assumes (2): intercoder agreement requires coders to
work *independently* and compare afterwards. (3) breaks local-first (§15) and
needs auth, hosting and an HTTP boundary.

What the code already gives us:

- **Event ids are ULIDs and inserts are idempotent** (`ON CONFLICT(id) DO
  NOTHING` in `provenance/src/writer.ts`), so two ledgers combine by set union
  with no conflict.
- **`artifact_id` is a sha256 of the artifact's initial state**
  (`cli/src/lib/events.ts`), so it means the same thing on every machine.
- **Every source file's sha256 is recorded at ingest** (ADR 0006), so two coders
  can confirm they worked from the same recording without syncing media.
- **Every event carries `parent_event`**, so two edits made from the same
  starting point are detectable as a fork.

What would close the door:

- **Sequential display ids used as identity.** `H-NNN` and `M-NNN` are minted as
  highest-so-far + 1 (`cli/src/lib/artifacts.ts`), so two coders offline both
  create `H-014`.
- **Weak identity.** The researcher id falls back from `$COMPOST_USER` to `$USER`
  to the literal `researcher` (`defaultResearcherId`). Two coders can be
  indistinguishable, which also defeats the self-endorse refusal (#236).
- **Replay depends on local insertion order.** Snapshots fold events
  `ORDER BY ts, rowid` (`provenance/src/snapshots.ts`); `rowid` differs between
  machines after a merge.
- **Endorsement is a single record.** The reducer stores one `_endorsement`, so a
  second endorser replaces the first.
- **Later edit silently wins.** Replay is a linear fold by timestamp; a fork is
  not surfaced.

## Decision

1. **The target is async multi-coder.** Not a shared server. Read-only sharing
   remains an `export` concern and is not blocked by anything here.
2. **Identity is git-style.** `user.name` and `user.email` live in compost config
   — global, with a per-seed override — and default to the machine's git identity
   when one exists. `$COMPOST_USER` and `--researcher` still take precedence. If
   nothing resolves, writes refuse with a message saying how to set it (git's
   "tell me who you are"). Identity stays self-declared; cryptographic proof
   (signed endorsements checked against trusted keys) is a separate, later layer
   per the tamper-evidence note.
3. **Conflicts are detected git-style, without git.**
   - Replay order is deterministic on every machine: `ts`, then event `id`.
   - Two events on one artifact with the same `parent_event` are a fork. A query
     lists artifacts with competing edits.
   - A researcher resolves a fork with a new event. Nothing is merged
     automatically and nothing is dropped silently.
   - No branches, no three-way text merge, no staging area: events never
     conflict, only an artifact's *current state* can have two heads.
4. **Endorsement is a list of endorsers.** Each endorse event is kept; an
   artifact is trusted with one or more, and the list shows who agreed. This
   merges by union.
5. **References use `artifact_id`.** ADR 0005 / #317 is the main prerequisite for
   merging and moves up the queue. Until it lands, no new reference may be keyed
   on an `H-`/`M-` number.
6. **No state outside the ledger.** Anything that changes what a researcher sees
   as "the analysis" is an event. Purely presentational state is either derived
   on the fly (the theme board's auto-layout, ADR 0007) or not kept.
7. **Transport stays out of the core** (ADR 0006 §4). compost will not sync.
   Ledgers travel by whatever means the team uses; the eventual verb is the
   inverse of `compost backup` — an idempotent "merge this ledger" — and it is
   **not built until a second coder exists**. `events.sqlite` itself must never
   be placed in a synced folder or committed to git: it is a binary file that
   sync tools corrupt and git cannot merge.
8. **Surfaces stay stateless.** The review artifact declares MCP access only —
   no shared artifact storage, no live presence — so the ledger remains the one
   source of truth. A shared compost, if ever needed, is the same MCP tools
   served over a network; no surface changes.

## What is built now vs. later

| Now (small, useful single-user too) | Later (needs a second coder to validate) |
|---|---|
| Deterministic replay order (`ts`, `id`) | `merge-ledger` verb |
| Git-style identity with refusal when unset | Competing-edits resolution UX |
| | List of endorsers (reducer + schema change) |
| | #317 reference-by-`artifact_id` migration |
| | Signed endorsements |

The list of endorsers and #317 are schema-affecting; they get their own issues
and clear the `CLAUDE.md` pre-flight individually.

## Consequences

- **Positive.** The irreversible mistakes (colliding ids, order-dependent replay,
  side-channel state) are ruled out before more data accumulates; identity
  becomes meaningful for the self-endorse check today.
- **Negative / accepted.** Identity refusal can interrupt a first run on a
  machine with no git identity (one config command fixes it). Fork detection
  means a researcher will occasionally be asked to resolve competing edits
  instead of the tool picking one.
- **Not decided.** How ledgers travel; whether merged-in events from another
  person need signatures before they are trusted; how codebook lenses from two
  coders reconcile (today's `codebook duplicate | merge` is the closest tool).

## Alternatives considered

- **Git as the transport** (export the ledger as one text line per event inside
  the seed, union-merged by git). Plausible and cheap later, but it builds sync
  before there is a second coder (pre-flight rule 4).
- **Later edit wins.** Simplest, but silently hides one researcher's decision —
  the opposite of what the ledger is for.
- **A hosted server.** Breaks local-first and makes compost a service to operate.
