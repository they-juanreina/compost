# ADR 0007: Visual surface re-scope — a review artifact plus a local player, not a web app

- **Status:** Accepted (2026-11-11), with the theme board kept in scope on a
  maintainer override — see decision 4. Resolves #310.
- **Date:** 2026-11-11
- **Deciders:** Juan (maintainer)
- **Amends:** [ADR 0003](./0003-interfaces-monorepo-plugin-tauri.md) §3 (the thing a
  future Tauri wrap would wrap gets smaller; the rest of 0003 stands)
- **Related:** #310, milestone "v0.3 — Visual researcher coding surface"
  (#119–#133), [review 2026-11](../review-2026-11.md), `CLAUDE.md` "The web UI",
  North Star §§11–14

## Context

The v0.3 milestone specifies a full Next.js application: seed home, transcript
player with drag-to-highlight, highlight detail and lineage, codebook page, theme
board, cross-session comparison, chat panel, frame strip, and `compost serve`.
Sixteen issues, none touched since June 2026, all gated by #310 ("needs
web-surface design first").

Three facts have changed or were not on the record:

1. **Four of the sixteen are already built.** #119–#122 (actions library, session
   and frame reads, artifact CRUD + endorse/reject, blame/agents/chat-retrieval)
   landed in `web/lib` in commits `b147567` and `6bc68cc`, with tests (51
   passing). The issues were never closed. No route files mount them — `web/app`
   is `layout.tsx` and `page.tsx` only.
2. **Claude artifacts can now call a local MCP server.** A published artifact page
   may declare `mcp` access to `host:<server>` — a local MCP server on the
   viewer's device — and call its tools with the viewer's consent. That makes an
   artifact a thin surface *by construction*: it can do nothing but call compost's
   typed tools. It only works when opened in the Claude desktop app on a machine
   where that server is connected.
3. **Artifacts cannot play local media.** Their storage is capped (20 MiB assets)
   and uploading interview audio would break local-first (§15) anyway.

Checking the MCP surface against what a visual surface needs also turned up two
gaps that are independent of which UI is chosen:

- **There is no `compost reject` verb.** `CLAUDE.md`, the addendum and
  `compost memo --help` all refer to it; the engine exports `rejectArtifact` and
  `web/lib` calls it; the CLI answers `unknown command 'reject'`. A researcher
  cannot reject an AI draft without writing code. That fails pre-flight rule 3.
- **There is no query that lists artifacts.** `status` returns counts only (no
  draft/endorsed split); `memo`, `codebook` and `category` each have a `list`,
  but highlights, codes and themes do not. Nothing — a person, an agent, or a UI —
  can ask "what is awaiting my endorsement?". That fails §8 (readable state).

And one constraint on what an artifact may do:

- **MCP create tools are AI-authored by design.** `compost_create_highlight|code|
  theme|memo` always pass `--ai` (#236), so anything created through them is born
  an AI `[draft]`. A researcher dragging a code into a theme on an artifact board
  would be recorded as the AI's suggestion. Adding researcher-authored create
  tools would fix the label but let any agent author *as the researcher* over the
  same channel. That is a provenance decision, not a UI one, and this ADR does
  not make it.

## Decision

Replace "a web application" with two thin surfaces, each limited to what only it
can do.

1. **A review artifact — the trust surface (§12, §13).** One HTML page shipped in
   the plugin and published to the researcher's own Claude account by a slash
   command. It declares `mcp` access to compost's local server and nothing else —
   no `db`, no `assets`, so corpus text is rendered but never stored off the
   machine. It does three things:
   - **Read:** seed overview, the endorsement queue, codes and themes with their
     evidence quotes across sessions, memos, lineage (`blame`).
   - **Endorse / reject** with preview-then-confirm rendered by the page, calling
     `compost_endorse` (identity bound server-side to `$COMPOST_USER`) and a new
     `compost_reject`.
   - **Nothing else.** It creates no highlights, codes, themes or memos, because
     over MCP those would be mislabelled as AI-authored.
2. **A local player — the direct-manipulation surface (§11).** `compost serve`
   shrinks to one page: media player synced to the transcript, cue and silence
   chips, select-to-highlight, and later the frame strip. Highlights created here
   are researcher-authored through the existing `web/lib/actions.ts`. It runs on
   localhost, offline, with no Claude account — it is the only visual surface that
   keeps rule 3 ("human stays free").
3. **No chat panel.** Claude is the chat. `compost chat` and `/compost-chat`
   already return citation-validated answers; a panel that calls a model is the
   "embedded reasoning loop" `CLAUDE.md` forbids, and fails kill-filter 1.
4. **The theme board is built now, in the local player — not the artifact.**
   Drag-to-theme is authoring, so it belongs to the surface where the researcher
   is the recorded author. Constraints:
   - **Verb first.** Changing a theme's evidence set must be a CLI verb in
     `cli/src/lib` before the board wraps it (house rule; rule 3).
   - **Auto-layout, nothing saved.** The board arranges itself from the data on
     every load. Card positions are not research decisions and are not stored —
     no `_layout.json`, no layout events — so there is no state outside the
     ledger to merge ([ADR 0008](./0008-multiplayer-door.md)).
   - **Maintainer override, recorded.** Pre-flight rule 4 comes back
     *grounded-but-not-demonstrated* (one study, one coder — addendum tension 4).
     The board is built on an explicit maintainer decision, as `codebook
     duplicate | merge` and analytic memos were.

### Prerequisites (core work, valid whichever UI ships)

| # | Work | Why it passes the pre-flight |
|---|---|---|
| P1 | `compost reject <ref>` CLI verb + `compost_reject` MCP tool, over the existing `rejectArtifact` | Documented as existing; durable state change no agent can make honestly without it; rule 3 |
| P2 | `compost list <kind>` (highlight \| code \| theme) with `--state draft\|endorsed\|archived` and evidence expansion, + matching MCP tool; `status` gains a draft/endorsed split | §8 readable state; a query over local durable state |
| P3 | Spike (do first): confirm a **plugin-bundled** MCP server is reachable from an artifact as `host:<name>` | The capability documents servers "from the user's MCP configuration"; whether a plugin's server counts is unverified. Fallback: register the server in the user's MCP config during `compost setup` |

P1 and P2 are a day or two of work and useful to a CLI-only researcher today. P3
is an hour and decides whether surface 1 is viable at all — do it first.

### Disposition of the milestone

| Issue | Was | Becomes |
|---|---|---|
| #119 actions library | open | **Close — shipped** (`b147567`) |
| #120 sessions + frames read | open | **Close — shipped** in `web/lib/server/sessions.ts`; route mounting moves to the player |
| #121 artifact CRUD + endorse/reject | open | **Close — shipped** in `web/lib/server/artifactRoutes.ts` |
| #122 blame / agents / chat retrieval | open | **Close — shipped** (`6bc68cc`) |
| #123 seed home | Next.js page | **Review artifact** (overview pane) |
| #124 transcript page | Next.js page | **Keep — local player.** The core of surface 2 |
| #125 highlight detail + lineage | components | **Review artifact** (lineage + endorse/reject) |
| #126 codebook page | page with edit + code merge | **Review artifact, read-only.** Edit and code-merge dropped: no such verb exists and the need is unvalidated |
| #127 theme board | drag canvas with saved layout | **Keep — local player**, after #124. Auto-layout; needs the evidence-set verb first |
| #128 cross-session comparison | page | **Review artifact** (code → evidence across sessions). Needs P2 |
| #129 chat panel | side panel | **Close — killed** (decision 3) |
| #130 frame-capture worker | in web milestone | **Keep, re-milestone.** Not web work; only worth building once the player can show frames |
| #131 frame strip | component | **Keep — local player**, after #124 |
| #132 glossary inline + badge polish | polish | **Close — fold** badges into the artifact, glossary spans into #124 |
| #133 un-stub `serve` + welcome | serve + first-run flow | **Keep, shrink** to launching the player. First-run welcome is already `/compost-welcome` and `compost setup` |
| #310 memo web surface | deferred | **Resolved:** memos are read and endorsed in the review artifact; authored via CLI or agent |

Net: sixteen issues become four closed as shipped, two closed as killed or folded,
one new issue for the review artifact (absorbing #123, #125, #126, #128, #310),
four for the player (#124, #127, #131, #133), one re-milestoned (#130), plus
P1–P3.

## Consequences

- **Positive.** Far less UI to build and maintain for a solo maintainer; the
  review surface cannot contain domain logic even by accident; the endorsement
  gate — the thing competitors' MCP servers lack — gets a visible home; P1 and P2
  close real holes in the CLI regardless.
- **Negative / accepted.**
  - The review artifact needs the Claude desktop app, a Claude account and a
    network connection. It is an accelerant, not the human-free path; the CLI
    (with P1 + P2) and the local player are.
  - It is **not team sharing.** A teammate who opens the link without compost and
    the seed on their machine sees an empty page. Sharing stays an `export`
    question.
  - Artifact capabilities are a moving platform contract; the page must degrade
    to "open this in the Claude app with compost connected" when `mcp` is absent.
  - The page is hosted on claude.ai. It holds no corpus data at rest, but quotes
    are rendered in a remotely served page. For studies where that is not
    acceptable, the CLI and local player are the surfaces.
- **Revisit when:** P3 fails with no workable fallback (then the review surface
  becomes a second local page in `serve`); or a study's data rules forbid a remotely served page.

## Alternatives considered

- **Build v0.3 as specified.** Twelve UI issues of Next.js for one maintainer, on
  a methodology layer validated against one study. Fails pre-flight rule 4.
- **Everything in an artifact.** Cannot play local media; would mislabel
  researcher authorship; removes the offline path.
- **No visual surface at all.** The 2026-07-01 dogfood session noted that a UI
  would resolve most of the black-box visibility issues it hit, and found the
  endorsement step heavy. Reviewing dozens of drafts one `blame` at a time in a
  terminal is the weakest part of the endorse gate today.
