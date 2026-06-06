# Design: Deepening provenance — inputs, agreement (κ), rerun, PROV-O

Status: **draft / in progress** · Branch: `feat/provenance-inputs-kappa-rerun`

This note designs four related additions to compost's provenance layer. They share
one root move (capture the *inputs* to a generation, not just a hash of them) and
build outward from it. Scope was chosen as "maximal": all four land here, with the
agreement metric gated on a methodologically sound Cohen's κ rather than a loose
endorsement rate.

## Why

compost's event log (`provenance/`) is an audit trail: it records *who* changed
*what* and *when*, with a three-actor model (researcher / agent / ai) and an
endorsement gate. Two gaps limit it:

1. **Inputs aren't reconstructable.** An AI event stores `model` + `prompt_hash`,
   where `prompt_hash = sha256(prompt + model + temp + ctx_window)`
   ([events.schema.json](../schema/events.schema.json)). The raw prompt, temperature,
   and retrieved context are discarded — only their one-way digest survives. So the
   log can verify *whether* two runs used identical inputs, but never *what* they
   were, and cannot regenerate a suggestion. This blocks both reproducibility and a
   meaningful standards export.
2. **Trust is asserted, not measured.** The endorsement gate exists to manage what
   the QDA literature calls "conditional trust," but compost computes no agreement
   metric between AI codings and human decisions.

## Components

### §1 — Input persistence (foundation)

Persist the actual generation inputs, content-addressed, so identical inputs dedupe
and any event can point at the bundle that produced it.

**Schema** (`provenance/src/migrations/0003_ai_inputs.sql`):

```sql
CREATE TABLE ai_inputs (
  input_id      TEXT PRIMARY KEY,   -- sha256 of the canonical bundle
  model         TEXT NOT NULL,
  params        TEXT,               -- JSON: {temperature, top_p, max_tokens, seed}
  system_prompt TEXT,
  prompt        TEXT NOT NULL,      -- rendered messages (JSON) or, for deterministic
                                    -- agents, a canonical description of the operation
  context       TEXT,               -- JSON: [{utterance_id, session_id, quote, content_sha}], etc.
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE events ADD COLUMN input_id TEXT REFERENCES ai_inputs(input_id);
CREATE INDEX idx_events_input ON events(input_id);
```

`input_id = sha256(canonicalJSON({model, params, system_prompt, prompt, context}))`.
`input_id` is nullable: researcher events carry none. `prompt_hash` stays for
back-compat; `input_id` is the new, *reconstructable* anchor.

**Two capture regimes** (the load-bearing architectural fact):

| Path | Who builds the prompt | Capture |
|---|---|---|
| Internal LLM / deterministic agents — `suggestThemesOnce`, `chat`, eval-grader | compost (`LLMAdapter` / clustering) | **Automatic** — inputs are in hand at the call site. |
| Host-agent creates — MCP `create_highlight/code/theme` | Claude Code, in its own context | **Best-effort** — compost only receives `--prompt-hash`. New optional `--inputs-file <path>` lets the wrapper hand over the bundle; absent → hash-only, as today. |

**Non-goals / caveats.** Backfill is impossible (existing events never captured
inputs → `input_id` NULL). Storing prompts + retrieved interview text in
`events.sqlite` is consistent with compost's filesystem-canonical, local-first model
(no new exposure), but is called out so it's a conscious choice.

### §3 — Bring deterministic enrichers into the graph (supports rerun)

`suggestThemesOnce` (the similarity-scanner, `actor_type=agent`) already emits code
drafts but records no inputs. Capture its bundle (`{threshold, minSize, embedding
model, member highlight ids + content hashes}`). Because it's deterministic, this
makes it a **clean** rerun target (exact reproduction).

### §4 — Agreement metric: Cohen's κ via blind double-coding

The report asked for "intercoder agreement (κ / Krippendorff)." compost's *native*
workflow produces endorse/reject decisions, not independent double-coding — so a κ
computed on that reactive process would violate κ's independence assumption. We ship
the methodologically sound version:

1. **Blind double-code mode.** A researcher codes a sampled subset of highlights
   against the shared codebook **without seeing AI codes**, producing researcher
   `code` events flagged `blind: true` (in payload + a `batch_id`). Non-interactive
   form for scripts/tests: `--assignments <json>` mapping highlight → code names.
2. **κ computation** (`cli/src/lib/agreement.ts`, pure + unit-tested against textbook
   values). For the doubly-coded highlight set, per code C build the 2×2 presence
   matrix across the two coders (AI/agent vs researcher-blind):
   `pₒ = agreements / n`, `pₑ = Σ marginal products`, `κ = (pₒ − pₑ)/(1 − pₑ)`.
   Provide Krippendorff's α (nominal) for the >2-coder / missing-data case.
3. **Surface** (honoring "build the `compost <verb>` first, then wrap"):
   `compost agreement --seed X [--json]` reads `events.sqlite`, finds doubly-coded
   units, reports κ/α per code + overall, plus secondary endorsement stats. A
   read-only MCP tool wraps the verb.

A unit is "doubly coded" iff it has both a blind researcher coding and an AI/agent
coding. Below a minimum n, κ is reported as `insufficient` (κ on a handful of items
is noise) rather than a misleading number.

### §2 — `compost rerun <event>`

Resolve an event → `input_id` → `ai_inputs`, re-run, emit a new event with
`parent_event` = the original (and a shared `batch_id`), diff the payloads.
- **Deterministic agents** (clustering): exact reproduction; clean diff.
- **AI (LLM)**: re-runs under the stored or an overridden model; the diff is *fuzzy*
  (LLM nondeterminism) — reported as such, not as a clean reproduction.
- Events whose `input_id` is NULL (pre-migration, or hash-only host creates) cannot
  be rerun; the command says so explicitly.

### PROV-O / PROV-AGENT export

`compost export --format prov` serializes the event log to W3C PROV (JSON-LD)
using the PROV-AGENT vocabulary (arXiv:2508.02866) for the AI/agent specifics:
`artifact → prov:Entity`, `event/action → prov:Activity`, `actor → prov:Agent`
(researcher = `prov:Person`; agent/ai = `prov:SoftwareAgent`), `parent_event →
prov:wasInformedBy`. PROV-AGENT classes: an `ai` actor → `provagent:AIAgent`; an
`ai` event → `provagent:AIModelInvocation` that `prov:used` a `provagent:Prompt`
(the captured input bundle) and a `provagent:AIModel` (the model), generating
`provagent:ResponseData` (the artifact); a deterministic agent's `name@version` →
`provagent:AgentTool`. With §1 landed, an AI invocation expresses its real
`prov:used` Prompt + AIModel instead of an opaque hash.

## Sequencing

§1 → (§3, §4 in parallel) → §2 → PROV-O → docs. Every phase committed green.

## Testing

- provenance: `recordInputs` dedup + `input_id` determinism; event `input_id`
  round-trip; migration 0003 applied on open.
- agreement: κ/α math against known textbook values; integration over a fixture seed
  with create/endorse/blind-code events; `insufficient` below min-n.
- rerun: deterministic agent reproduces exactly; NULL-input event refused.
- prov: serializer emits valid JSON-LD with expected nodes/relations.

## Surfacing rule

A provenance feature is only an *agent* capability when it's a CLI verb **and** an
MCP tool. `agreement`, `rerun`, and `export --format prov` are all surfaced both
ways (the shipped `.eaf` exporter, reachable from the CLI but absent from the
`compost_export` MCP schema, is the cautionary precedent we avoid).
