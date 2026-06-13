# North Star — A Design Philosophy for Humans and Agents

> **Status:** v2 / living document.
> **What this is:** Not a spec for one product — a design philosophy that spans everything you make, from research instruments and tools to home automation, and that you can bring to design challenges at work. It answers two questions before any project: *should this exist?* and *where should my effort go?*
> **Use it to:** stay aligned to the stance, decide what is worth building and worth your time, audit and kill ideas critically, and (per project) derive enforceable rules for Claude Code.
> **Voice:** guiding and evaluative, not a rulebook. Stars to steer by, and a filter to cut by.

---

## Thesis

The product is an **instrument**, not a co-pilot. The agent plays it, the human directs, and both reach for the same keys.

You build **one capability layer** — typed operations and queries over a local-first store — and project it onto multiple **surfaces**: the human interface, a host platform's native agent layer, and any external agents. Human and agent are two callers of the same API; one rendered for human perception, the other as a machine-readable contract.

There is nothing to replicate, because the capability exists once, underneath both. The hard part — and the only part worth your effort — is deciding *what* belongs in that layer.

---

## I. Should this exist? (the kill filter)

**1. Build only the irreplaceable.**
If an agent can already reach the outcome without your product, there is nothing to build. A product earns its existence only by providing what no agent can get on its own: private or local data, control over a device or the physical world, durable and verifiable state, provenance, and a direct human interface. Everything else is the agent's job.
*Kill test:* Can an agent achieve this outcome without my product? If yes, stop — you're about to build something an agent will surpass.

**2. The product is an instrument, not a co-pilot.**
No embedded conversational agent, no reasoning loop, no reimplementing what the agent already does. Supply capabilities, visible state, and verification; let the agent do the reasoning.
*Kill test:* Am I rebuilding the agent? Expose a capability instead.

**3. Never require the agent; never trap the human in chat.**
Every goal must be achievable by a person, directly, with no agent involved. Delegation is one path to the goal — never the only one. Don't lock people into a chat box, and don't let the product stop working when the AI is absent. The agent is an accelerant, not a life-support system.
*Kill test:* If every agent vanished tomorrow, could a person still do everything here? If no, you've built a dependency, not a tool.

---

## II. Where does my effort go? (the same filter, turned on yourself)

Principle 1, applied to you. Your scarce, irreplaceable contribution is **research, design, and problem-mapping** — naming the real problem and shaping the solution. That is the work. Writing code is not the work; it's the delegable part.

**4. Spend yourself on the irreplaceable: framing problems and designing capabilities.**
A project deserves your time only when it needs your judgment — when the hard part is *understanding the problem and shaping the capability layer*, not producing code an agent could spec and build without you.
*Effort test:* Is the difficulty here in the thinking or in the typing? If it's the typing, delegate it.

**5. Lean on agents for implementation; don't mistake code volume for progress.**
Use agents to write and refactor the assisted code so you stay on research and design. Direct and verify the implementation; don't grind it by hand.
*Effort test:* Am I hand-building this to feel productive, or because it genuinely needs me?

---

## III. Architecture

**6. One capability layer, many surfaces.**
Every action is a typed command (or query) in a shared domain core. Every surface — human interface, native agent layer, external agent — is a *thin adapter* with no logic of its own.
*Audit:* Could I add a new surface (a CLI, a new device, another agent) without touching business logic?

**7. Name verbs and nouns once.**
The label a human sees, the name the native agent layer uses, and an external agent's tool name for the same operation must match. One vocabulary across all surfaces.
*Audit:* Does the human-facing label match the names every agent surface exposes?

**8. Readable state, not just writable.**
Expose queries, current selection, and "what can I do right now" — not only mutations. Agents and humans both act badly when they can't see current state.
*Audit:* Can an agent answer "what exists and what's possible right now" without guessing?

**9. Invalid states are unrepresentable.**
Model with precise types and constrained value sets, not free strings. Operations are transactional and idempotent — they fully apply or cleanly reject.
*Audit:* Can a caller construct a call that reaches a state I didn't intend?

**10. Errors are structured and actionable.**
Every failure says what was wrong and how to fix it — so the agent self-corrects and the human interface shows a clean inline fix instead of a crash.
*Audit:* Could an agent read this error and retry correctly without a human?

---

## IV. Interaction & trust

**11. Direct manipulation for the irreducible; delegate the rest.**
Keep fast the things faster to *do* than to *describe* (drag, scrub, pick, reorder, turn a dial). Everything procedural, repetitive, or multi-step should be delegable.
*Audit:* Is this element earning its place, or is it better asked for than operated directly?

**12. Consequential actions get native preview-then-confirm.**
For anything destructive, costly, or hard to reverse: the agent proposes, the product renders the diff in its own interface, the human approves. The confirmation lives in the product, not in the agent conversation.
*Audit:* If the agent did this and I disagreed, how fast could I catch it first?

**13. Provenance is mandatory; history is a surface.**
Every change records who did it (human / which agent) and is reversible where possible. The action history is first-class and scannable — the trust surface that makes heavy delegation feel safe rather than spooky.
*Audit:* Can a person glance and know what the agent just changed, and undo it?

**14. Shared context is an affordance.**
When the human selects something and asks the agent to act, the agent inherits that selection. "Current context" must be readable by the agent.
*Audit:* Can the agent act on "these" without the human re-describing what "these" are?

**15. Local-first and private by default.**
Data and compute stay on the user's own device or infrastructure. Any reach beyond it (e.g., exposing a local capability to a remote agent) is explicit, minimal, and opt-in.
*Audit:* If the network disappeared, what still works? It should be most of it.

---

## Before you build anything (run the idea through this, in order)

1. **Should it exist?** Can an agent already reach this outcome without me? (1) — if yes, kill it.
2. **Is it the agent's job?** Am I rebuilding reasoning the agent already does? (2)
3. **Does it keep the human free?** Fully doable without any agent, no chat lock-in? (3)
4. **Is it *my* work?** Is the hard part the thinking or the typing? (4, 5)
5. **Does it add to the core, or bolt logic onto a surface?** (6)
6. **One vocabulary?** A new word for an existing thing? (7)
7. **Visible and safe?** Readable state, unrepresentable bad states, recoverable errors? (8–10)
8. **Right modality?** Direct action vs. delegation; preview + undo for consequential acts? (11, 12)

Fail the first three and the idea is dead on arrival, however well-built. Fail three or more of the rest and it needs rework before it touches anything.

---

## Per-project instantiation

This philosophy stays generic. Each concrete project gets a short addendum that grounds it:

```
# <Project> — addendum to the North Star
- What's irreplaceable here: <the data / control / state only this product can provide>
- Entities (nouns):        <stable domain objects>
- Capabilities (verbs):    <the typed commands & queries>
- Surfaces in scope:       <human UI / native agent layer / external agents>
- Self-service guarantee:  <how a person does all of this without an agent>
- Provenance & reversibility: <what's logged, what's undoable>
```

When you pick a project, that addendum can also be compiled into a machine-enforceable `CLAUDE.md` rules block so Claude Code checks work against these principles mechanically. Ask for it then.

---

## Shared vocabulary (use consistently, including with Claude Code)

- **Capability core / domain core** — the single module of typed commands and queries; the source of truth for behavior.
- **Command** — a typed, validated, idempotent operation that mutates state.
- **Query** — a typed read of current state, including "what's possible now."
- **Surface** — a thin adapter exposing the core: a human interface, a native agent layer, an external agent.
- **Entity** — an addressable noun in the domain (stable ID), referenceable by every surface.
- **Provenance** — the recorded actor (human / agent) and origin of a change.
