# compost — addendum to the North Star

This grounds the [North Star design philosophy](north-star-humans-and-agents.md) in
compost specifically. The philosophy stays generic; this says what's
irreplaceable *here*, what the nouns and verbs are, and how the kill/effort
tests apply to compost work. The machine-enforceable form lives in the
repo-root [`CLAUDE.md`](../CLAUDE.md).

> **The one-sentence stance:** compost is the **provenance-bearing, local-first
> store and verifier** for qualitative analysis — *not* the analyst. The agent
> and the human do the interpreting; compost holds the corpus, runs the
> reproducible computations, records who decided what, and gates AI output
> behind human endorsement.

## The layer

- **What's irreplaceable here** — the append-only provenance ledger
  (`.compost/events.sqlite`: three-actor, canonical, *not* rebuildable from the
  markdown); the local-first corpus + embeddings (audio/legacy ingest, Ollama +
  LanceDB, offline); reproducible computation over local state (κ/α agreement,
  saturation, hybrid retrieval); the `[draft]` → human-endorse gate; and the
  direct human/CLI interface. **NOT irreplaceable, and therefore not compost's
  job:** the interpretation itself — reading a transcript and deciding what it
  means. That is the agent's and the researcher's reasoning.
- **Entities (nouns)** — `seed`, `session`/`transcript`/`utterance`,
  `highlight`, `code`, `codebook` (interpretive lens/frame), `category`
  (second-cycle grouping), `theme`, glossary `term`, and the append-only
  `event`. Stable ids: `S001`, `U-0001`, `H-001`, `C-<codebook>/<code>`,
  `CB-<slug>`, `CAT-<slug>`, `T-<slug>`.
- **Capabilities (verbs)** — typed commands and queries in `cli/src/lib` (the
  domain core). Commands mutate + emit events: `create highlight|code|theme`,
  `codebook new|migrate|migrate-ids`, `category new|link|unlink|suggest`,
  `endorse`, `reject`, `recode`, `ingest`, `transcribe`. Queries read current
  state: `search`, `chat` (grounded, cited), `session`, `status`, `blame`,
  `saturate`, `agreement`, `export`.
- **Surfaces in scope** — the **CLI** (human, JSON-by-default), the **Claude
  Code / Cowork plugin** (native agent layer: slash commands + MCP tools), and
  a **web UI** (upcoming — must be a thin surface, no logic). External agents
  reach the same core through the CLI/MCP. Each surface is an adapter over
  `cli/src/lib`; invariants (in_vivo, cross-lens ≥2, one-primary-per-code,
  codebook scoping) live in `lib` so every surface honors them.
- **Self-service guarantee** — every verb is a CLI command a person runs
  directly. No agent is ever required; nothing is chat-locked; it works offline
  (local Ollama/LanceDB). The agent is an accelerant, not life support.
- **Provenance & reversibility** — every artifact change is an append-only
  event tagged with its actor (researcher / agent / ai). AI-authored artifacts
  land as `[draft]` until `endorse`; `reject` archives (never deletes); `blame`
  prints the lineage; markdown is rebuildable from the ledger (`reindex`), never
  the reverse. `migrate-ids` records id renames as `update{field:id}` events so
  even identity changes keep their lineage.

## Live tensions (audit, 2026-06-13)

Carried from the v0.2.0 critical review — the places where compost is *closest
to the line* and should be re-tested before extending:

1. **Speculative foundation (kill filter, §1/§4/§5).** The qualified-code-id
   scheme + `migrate-ids` were built to support `codebook duplicate | merge`
   (verbs settled 2026-06-13, was `merge | fork | import`) — verbs that don't yet
   exist and haven't passed the kill test ("can an agent combine two codebooks
   without this?"). The vocabulary is now grounded in the methodology library
   (`docs/design-codebook-merge-fork-import.md`); the *need* still isn't. Freeze
   the scheme; don't extend it until the verbs earn their existence on a real
   two-lens study.
2. **Capability vs. reasoning (§2).** `category suggest` / `code` / `rescan`
   cluster embeddings to *propose* groupings. The computation is a legitimate
   local capability; framing the output as "AI-proposed categories/codes" edges
   into the agent's interpretive job. Keep them as untrusted deterministic-actor
   `[draft]`s (which the endorsement gate enforces), or expose the raw query
   ("which codes are near each other?") and let the reasoner decide.
3. **Vocabulary debt (§7).** A migration-window has two code-id forms (qualified
   + bare shim), and `web`/`MCP` create themes via `codes`, not `evidence`. Pay
   this down before the UI names anything.
4. **Thin validation.** The whole methodology layer is validated against one
   dogfood (Edges & Ecotones, one coder). Get a second, independent corpus
   before adding more apparatus.

## CLAUDE.md compilation

The repo-root `CLAUDE.md` turns this addendum into mechanical checks Claude Code
applies to every change. When the layer's nouns/verbs/surfaces shift, update
both this addendum and that rules block together.
