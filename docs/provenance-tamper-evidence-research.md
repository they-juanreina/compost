# Research: Tamper-evident provenance — fingerprinting human & agent actions

Status: **research / draft** · Branch: `claude/provenance-git-security-ybpyyh`

Companion to [provenance-deepening-design.md](provenance-deepening-design.md). That
note deepens *what* an event records (inputs, agreement κ, rerun, PROV-O export).
This note addresses a different complaint: the event log is **soft and easy to
hack** — `actor_id` is a self-asserted string and `events.sqlite` is append-only
*by convention only* (no hash chain, no signatures, no integrity check on read; see
[SECURITY.md](../SECURITY.md), which scopes adversarial local writes *out*). The
goal here: put **verifiable fingerprints** on every human and agent action so each
one can be traced back to who — or what — performed it.

This is a research note, not a shipped design. It records findings and a phased
recommendation; nothing here is built. Per [CLAUDE.md](../CLAUDE.md), each phase
must clear the pre-flight kill filter before it earns code.

## TL;DR

1. **Tamper-evidence is cheap and local; tamper-resistance is not.** Structuring the
   ledger as a Merkle/history tree makes any retroactive edit *detectable* with no
   network. But detection always compares against a **previously-witnessed** root.
2. **The decisive variable is the threat model.** Against the AI agent or a synced
   peer, signatures are decisive. Against the **machine owner** — who holds all keys
   and can rewrite *and re-sign* the whole ledger — no purely local mechanism helps.
   Only an **external witness/anchor** the owner doesn't control restores
   non-repudiation. This is a fundamental limit, not an implementation gap.
3. **Highest traceability-per-effort, in order:** hash-chain the events → sign
   consequential events (especially human `endorse`) with per-actor keys → anchor
   the ledger head externally, opt-in, for anyone who must prove history to a third
   party.

## What the question really is

"Fingerprint, traceable back" decomposes into three *separable* properties. Most
confusion comes from treating them as one:

| Property | Answers | Mechanism | Needs network? |
|---|---|---|---|
| **Integrity / tamper-evidence** | "has history been edited?" | hash chain / Merkle tree | No |
| **Authentication / non-repudiation** | "*who* did this, provably?" | digital signatures | No (key mgmt local) |
| **Anti-rewrite vs. the owner** | "was history rewritten *after the fact*?" | external witness / anchor | Yes (opt-in) |

compost today has **none** of the three. `prompt_hash` is a content fingerprint, not
an integrity chain; `actor_id` is a claim, not a proof.

## Findings (from verified research)

Each finding below was confirmed by adversarial 3-vote verification against primary
sources. Confidence and sources are noted.

### F1 — Use a Merkle/history tree, not a bare hash chain (high)

Tamper-evidence needs both **inclusion** proofs ("event X is in the log at index i")
and **consistency** proofs ("the log now is the old log plus appends" — nothing was
rewritten). A single chained hash gives append-time integrity but can't efficiently
prove two published roots are mutually consistent. The **history tree** (Crosby &
Wallach, USENIX Security 2009) and **RFC 6962 / Certificate Transparency** provide
both with logarithmic-size proofs. Any retroactive edit changes the root, so
tampering surfaces during proof verification — *relative to an earlier witnessed
root*.
Sources: Crosby & Wallach 2009 (`static.usenix.org/event/sec09/tech/full_papers/crosby.pdf`); `github.com/rozbb/ct-merkle`.

### F2 — It's cheap enough for a single-user tool (high)

The history-tree construction sustained **>1,750 events/sec and >8,000 audits/sec on
2009 hardware**, with proofs that work even when the full tree doesn't fit in memory.
A qualitative researcher generates events at human speed — orders of magnitude below
this. Tamper-evident logging is essentially free here.
Sources: Crosby & Wallach 2009; ct-merkle.

### F3 — The model assumes an *untrusted logger* — which is exactly compost's case (high)

Tamper-evident logging is formally defined around a logger that may be malicious,
kept honest by **external auditors** who challenge it. "While logs are tamper-evident,
they are not tamper-proof, making a monitoring solution essential" (Sigstore). The
implication is sharp: **a log cannot prove its own integrity.** A single offline
machine *is* the untrusted logger with no external auditor — which is precisely why
local-only tamper-evidence is insufficient against the owner.
Sources: Crosby & Wallach 2009; `docs.sigstore.dev/logging/overview/`.

### F4 — Bind actions to identities with signatures; keyless is possible but pulls in dependencies (high)

git/GitHub verify a commit's *integrity* but "not WHO put the data there." Signatures
fix attribution. **Sigstore/gitsign** demonstrates a *keyless* variant: ephemeral
~10-minute certificates bound to an OIDC identity, no long-term key to manage — but
verification then depends on an external CA + the Rekor transparency log (GitHub
won't even show these as "verified" because Sigstore's root isn't in its trust
store). For an **offline-first** tool this dependency is a poor fit; simpler
self-managed **long-lived ed25519** keys are more appropriate, reserving
Sigstore-style for when third-party verifiability genuinely matters.
Sources: `github.com/sigstore/gitsign`.

### F5 — Expiring-cert schemes *require* a transparency log to stay verifiable (high)

Because gitsign certs are short-lived, commits are recorded in **Rekor** so they
still verify after expiry. This is the general pattern: keyless signing trades local
key management for a hard dependency on external transparency infrastructure. Name
the trade explicitly before adopting it.
Sources: `github.com/sigstore/gitsign`.

### F6 — A transparency log (Rekor) is the external witness — but it's centralized (high)

**Rekor** is an immutable, tamper-evident ledger of signed metadata built on a Merkle
tree; anyone can verify inclusion/consistency or look up entries by key or artifact.
It is exactly the external auditor F3 says the local case lacks — but Sigstore runs
it as a **centralized hosted service** (`rekor.sigstore.dev`, ~99.5% SLO). Adopting
it means accepting centralized infra, in tension with local-first.
Sources: `docs.sigstore.dev/logging/overview/`.

### F7 — External temporal anchoring defeats history rewrites without trusting any operator (high)

Commit the ledger's root hash to an **independent, publicly verifiable ledger** —
the SCITT temporal-anchor draft uses **OpenTimestamps → Bitcoin**. This proves the
log existed at-or-before a point in time; the proof is **independently verifiable by
anyone with ledger state, with no trusted third party, and survives the log's
disappearance.** This is the one mechanism that meaningfully constrains the machine
owner: they can rewrite local history, but they cannot retroactively change what was
already anchored. Caveat: the SCITT draft is an individual IETF Internet-Draft (rev
01), not a ratified standard; trust shifts to Bitcoin consensus rather than vanishing.
Sources: `datatracker.ietf.org/doc/draft-fassbender-scitt-time-anchor/01/`.

### F8 — Don't hand-roll the crypto (high)

Reference Merkle/transparency implementations carry "not audited — use at your own
peril" warnings. Use a mature/audited library (or the host's existing crypto
primitives), not a bespoke construction.
Sources: ct-merkle; NIST CSRC crypto-audit guidance.

## Gaps in this research pass (treat as lower confidence)

The verified findings did **not** substantiate two requested sub-topics. Flagged
honestly so they aren't mistaken for confirmed:

- **AI-specific provenance standards** (C2PA / Content Credentials, "AI bill of
  materials" / CycloneDX ML-BOM, model+prompt+params as signed metadata). Sources
  were found but none survived to a verified claim. The general principle holds — the
  *action payload* can embed a signed `{model, prompt_hash, params, agent_identity}`
  bundle — but the concrete standard to adopt for **text** artifacts is an open
  question. (C2PA is image/media-centric; its fit for QDA codes/memos is unproven.)
  This dovetails with the PROV-O work already scoped in the companion note.
- **Frameworks** (W3C PROV, OWASP append-only logging, NIST, Verifiable
  Credentials). Not directly evidenced in this pass — only git/Sigstore/Rekor/CT
  patterns were. W3C PROV mapping is already tracked in
  [provenance-deepening-design.md](provenance-deepening-design.md); treat that as the
  canonical place for the standards-export angle.

## The security ceiling (read this before building anything)

For a purely offline single-user tool, the **realistic ceiling is
detection-of-edits-relative-to-a-previously-witnessed-state.** Spelled out by threat:

- **AI agent writes without sign-off** → already handled at the app layer by the
  endorsement gate; crypto adds little. (Signing makes a forged "researcher created
  this" detectable, which *is* worth something.)
- **A synced peer / co-researcher forged who-decided-what** → per-actor signatures
  are decisive. This is the strongest reason to sign.
- **The machine owner faked their own provenance** → *no local mechanism helps.* They
  hold every key and can rewrite and re-sign a fully self-consistent ledger. Only
  external anchoring (F7) — to infrastructure they don't control — constrains them,
  and only for state anchored *before* the tampering.

So "make provenance hard to hack" has no purely-local answer for the owner-as-adversary
case. Decide which adversary matters before writing code; the answer changes the scope
from "one hash-chain column" to "anchoring infrastructure + UX."

## Recommendation for compost (phased, kill-filter-gated)

Ordered by traceability-per-effort. Each phase is independently shippable and must
pass the [CLAUDE.md](../CLAUDE.md) pre-flight before it earns code.

### Phase 1 — Hash-chain the event ledger (local, no network)

Add a `prev_hash` (and per-row `entry_hash`) to the events table; each event commits
`H(canonical_payload ‖ prev_hash)`. Expose a `compost verify` query that recomputes
the chain and reports the first divergence. Keep `events.sqlite` canonical — this is
a derived integrity column, consistent with "markdown derives from events, never the
reverse."
- *Touches:* `provenance/src/migrations/` (new migration), `provenance/src/writer.ts`
  (compute on append), a `reduce`-time verification path, new `verify` command/query.
- *Why first:* offline, cheap (F2), self-consistent immediately, no key management.
- *Ceiling:* detects edits only relative to a root you've seen before (F1, F3).

### Phase 2 — Sign consequential events with per-actor keys

Sign at least `endorse` / `reject` (the human trust gate — highest-value assertion
and the natural tamper target) with a local **ed25519** key per actor; verification
checks the *signature/key*, not the `actor_id` string. This finally makes the
endorsement gate's anti-self-endorse check (currently a string compare in
`artifacts.ts`) cryptographic. Prefer self-managed long-lived keys over Sigstore
keyless for the offline case (F4, F5).
- *Open design:* key storage/rotation UX for a single-user tool; how agent/ai keys
  are provisioned vs. the human's; what happens on key loss.
- *Ceiling:* binds actions to keys, not humans — the owner can still mint keys.

### Phase 3 — Optional external anchoring of the ledger head

For users who must *prove* to a third party that history wasn't rewritten, anchor the
Merkle root periodically via **OpenTimestamps** (F7). Strictly opt-in and offline by
default, honoring local-first (§15). This is the only phase that constrains the
machine owner.
- *Gate hard here:* this is the phase most likely to fail the kill filter (#1: can an
  agent already reach this? #3: still fully usable offline?). Build only against a
  validated need to prove history externally — don't add anchoring infrastructure
  speculatively.

### Explicitly *not* recommended now

- A hosted Rekor dependency (F6) or keyless/OIDC signing (F4/F5) — both import
  centralized/network dependencies that fight local-first, with no validated need yet.
- Hand-rolled Merkle code (F8) — use an audited library or the host's crypto.
- C2PA for text artifacts — unproven fit; revisit with the PROV-O export work.

## Open questions

1. **Which adversary?** (agent / synced peer / machine owner) — this gates whether
   Phase 3 is ever in scope.
2. Per-actor key-management design for a single-user offline tool (Phase 2).
3. Canonical signed schema for AI fingerprints — `{model, prompt_hash, params,
   agent_identity}` — and whether it rides the existing `ai_inputs` bundle.
4. Minimal viable anchoring cadence/UX that preserves offline operation (Phase 3).
5. Should `endorse` events get stronger signing/anchoring than ordinary mutations,
   as the highest-value provenance assertions?

## Sources (verified, primary)

- Crosby & Wallach, *Efficient Data Structures for Tamper-Evident Logging*, USENIX
  Security 2009 — `static.usenix.org/event/sec09/tech/full_papers/crosby.pdf`
- `github.com/rozbb/ct-merkle` (RFC 6962 / Certificate Transparency Merkle proofs)
- `github.com/sigstore/gitsign` (keyless commit signing)
- Sigstore Rekor — `docs.sigstore.dev/logging/overview/`
- SCITT external temporal anchoring (IETF I-D, rev 01) —
  `datatracker.ietf.org/doc/draft-fassbender-scitt-time-anchor/01/`

*Method: 5-angle fan-out web search → 24 sources fetched → 25 falsifiable claims →
3-vote adversarial verification (25 confirmed, 0 refuted) → synthesis. Sub-topics on
AI-specific standards (C2PA/ML-BOM) and frameworks (W3C PROV/OWASP/NIST/VC) were not
substantiated by verified claims this pass and are flagged above as lower-confidence.*
