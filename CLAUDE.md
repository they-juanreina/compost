# CLAUDE.md — working rules for compost

Mechanical checks derived from the [North Star](docs/north-star-humans-and-agents.md)
and its [compost addendum](docs/north-star-addendum.md). Apply these to **every**
change. They override the urge to build; when a rule and a request conflict,
surface the conflict.

**Stance (don't violate this, ever):** compost is the **provenance-bearing,
local-first store and verifier** for qualitative analysis — *not* the analyst.
The agent and the human interpret; compost holds the corpus, runs reproducible
computations, records who decided what, and gates AI output behind human
endorsement.

## Pre-flight — run before adding any capability or feature

Stop at the first failure.

1. **Kill filter.** Can an agent already reach this outcome *without* compost?
   If yes — stop. compost earns a capability only by providing what no agent
   can get alone: local/private data, device/physical control, durable
   verifiable state, provenance, or the direct human interface.
2. **Not the analyst.** Does this add reasoning/interpretation compost should
   not own (proposing what a transcript *means*, an embedded chat/reasoning
   loop)? If yes — expose a capability or query instead, and let the agent/human
   reason. Clustering/stats are capabilities; *presenting their output as an
   interpretation* is not.
3. **Human stays free.** Is it fully doable from the CLI by a person, with no
   agent, offline? If no — you've built a dependency, not a tool.
4. **It's your work, not mine to pad.** Is the hard part the *thinking*
   (problem-framing, the data model, the invariant) or the *typing*? If it's
   typing for a need that isn't validated, say so before building — code volume
   is not progress.

Fail 1–3 → the idea is dead. Fail 4 → name the unvalidated assumption to the
human first.

## Architecture rules (enforced)

- **One core, thin surfaces.** Every behavior is a typed command or query in
  `cli/src/lib` (the domain core). The CLI command (`cli/src/commands`), the MCP
  tools (`plugin/mcp/tools.ts`), and the web actions (`web/lib/actions.ts`) are
  **adapters with no domain logic** — they parse input, call `lib`, render
  output. If you're writing an `if` about *meaning* in an adapter, it belongs in
  `lib`.
- **Invariants live in `lib`, once.** in_vivo enforcement, cross-lens ≥2,
  one-primary-per-code, codebook scoping, the bare-code-ref shim — all in `lib`
  so CLI + MCP + web honor them identically. Never re-check an invariant in a
  surface; never let a surface bypass one.
- **Name it once (§7).** The CLI verb, the MCP tool name, and the human-facing
  label for one operation must match. Adding a synonym for an existing thing is
  a bug.
- **Readable state (§8).** Expose the query, not just the mutation — a caller
  must be able to ask "what exists / what's possible now" (`status`, `blame`,
  `list`, `search`) without guessing.
- **Invalid states unrepresentable (§9).** Precise types and constrained sets,
  not free strings; operations transactional + idempotent (fully apply or
  cleanly reject — e.g. `writeArtifactAtomic`, the `migrate-ids` collision
  guard).
- **Structured, actionable errors (§10).** Throw `CompostError` with a code and
  a message that says what was wrong *and how to fix it*, so an agent
  self-corrects and a surface shows an inline fix, not a crash.

## Provenance & trust rules (non-negotiable — §13)

- Every artifact mutation emits an **append-only event** tagged with its actor
  (`researcher` / `agent` / `ai`). No silent writes.
- AI-authored artifacts are born **`[draft]`** and stay untrusted until
  `endorse`. Nothing bypasses the endorsement gate. `reject` archives — never
  deletes.
- `.compost/events.sqlite` is **canonical and not rebuildable**; markdown
  derives from it (`reindex`), never the reverse. Identity changes (e.g.
  `migrate-ids`) are recorded as events too.
- Consequential/irreversible ops (file moves, mass rewrites, publishes) are
  **dry-run-first** and refuse on risk (e.g. `migrate-ids` aborts on a dirty git
  tree and on a path collision). The human previews; the product — not a chat
  message — renders the confirmation.

## Local-first (§15)

Data and compute stay on the user's machine (filesystem canonical, Ollama +
LanceDB local). Any network reach is explicit, minimal, opt-in. If the network
vanished, most of compost still works — keep it that way.

## Effort (§4–5) — for the human and for me (Claude)

The human's scarce contribution is research, design, and problem-mapping.
Implementation is delegable. So: I do not hand-grind plumbing to look busy, and
I do not let a large diff stand in for a validated need. When a task is large
and its demand is unproven, I say so and recommend validating before building.

## Do NOT extend without re-testing (current live tensions)

From the v0.2.0 audit (see the addendum):

- **`codebook merge | fork | import`** + the qualified-code-id scheme — built
  ahead of a proven need. Run the kill filter on the verbs *before* writing
  more; don't deepen the id scheme meanwhile.
- **`category suggest` / `code` / `rescan`** — keep as untrusted
  deterministic-actor `[draft]`s, or reframe as a raw "nearby codes" query;
  don't let compost present groupings as interpretation.
- **Vocabulary debt** — two code-id forms (qualified + bare shim); web/MCP still
  speak `codes` not `evidence`. Pay this down before the web UI names anything.
- **The web UI** — must be a *thin surface*: direct manipulation for the
  irreducible (§11), preview-then-confirm for consequential acts (§12), history
  as a scannable trust surface (§13), shared selection as agent context (§14).
  No business logic, no embedded reasoning loop. Do not render unvalidated
  features (the codebook verbs, AI-suggestion-as-truth) into it.
