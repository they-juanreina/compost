# Onboarding journey — audit and target design

A map of the new-user journey from installation to first ingestion, with every
failure point observed in the 2026-06-09 field test (a researcher following the
provisional wiki on an Apple Silicon Mac), and the design that closes each gap.
Companion to the [Your First Study wiki page] and the `compost setup` wizard.

## The journey, as designed vs. as experienced

Each stage lists what the product intends, what actually happened in the field
test, and where the fix lives.

### Stage 0 — Install the CLI

**Intent:** `npm i -g @they-juanreina/compost-cli`, once.

**Observed:** the machine had `0.1.0-rc.2` installed from an earlier session.
Nothing — not `setup`, not any command — surfaces that a newer release exists,
and the rc predated the bundled transcriber (#206), so `setup
--provision-native` failed with a message suggesting env vars instead of an
upgrade. The user concluded their machine was broken. (#245)

**Fix:** `setup` gains a version check against the npm dist-tag (best-effort,
silent offline); locator errors append the upgrade command. (#245, open)

### Stage 1 — `compost setup`

**Intent:** one command that tells you where you stand.

**Observed:** four distinct gaps.

1. It reported `ready: true` while the pipeline could not process a single
   file — transcriber checks are warn-level, but document ingest hard-requires
   the engine. (#242)
2. It *names* the HF token gap but nothing collects it: the fix string says
   `export HUGGINGFACE_TOKEN=…`, which assumes the user knows what an env var
   is and that the setting survives the terminal session (it doesn't). The
   user's words: *"I am not being prompted about the HF token, so I am unable
   to proceed."*
3. Fix strings assume a repo checkout: `docker compose -f
   transcriber/compose.yaml up` is relative to nowhere on a global install
   (the bundled dir lives under the npm prefix).
4. It is read-only by design — every fix is a copy-paste round-trip through a
   terminal the target audience is explicitly not assumed to know.

**Fix:** the interactive wizard (this change). At a TTY, `compost setup` walks
each gap with a per-step confirmed fix: starts/pulls what's missing, provisions
the venv, prompts for the HF token (hidden input, stored in the OS keychain via
`compost secrets`), and offers the chat-model choice (local pull vs. cloud
key). `--json` (or any non-TTY invocation) keeps the read-only diagnostic
behavior byte-for-byte, so agents and CI see no change. `ready` becomes `false`
when no ingest engine is available (#242).

### Stage 2 — Create a workspace and a seed

**Intent:** `cd ~/Research && compost init my-study`.

**Observed:** "any cwd with a `Seeds/` child is a compost workspace" is too
implicit. Running `init` from inside a folder named `Seeds` silently nests
`Seeds/Seeds/` (#241 — warning shipped in #244). Worse, the user's
*pre-existing research archive* at `~/Seeds` — unrelated to compost — gets
adopted as a workspace by any command run from `~`, and `watch --seed <name>`
would scaffold `.compost/` state into those folders (#241 comment).

**Fix (shipped):** `init` warns on the nesting case. **Fix (recommended,
below):** an explicit workspace marker.

### Stage 3 — First ingestion

**Intent:** drop a file in `sessions/_inbox/`, run `compost watch --once`.

**Observed:** the dense failure cluster of the field test.

- Both files dropped at once → session numbering surprises the wiki's
  hardcoded `S001` (#243; wiki fixed).
- Engine missing → each job silently burned 3 attempts and parked as an
  invisible, unrecoverable dead letter; `watch` said `ok`, `status` said
  `queued`. (#239 — fixed in #244: `compost jobs`/`requeue`, `watch` exits
  non-zero with the recovery command, `status` warns.)
- Queue rows store absolute paths, so hand-moving the seed folder strands
  them. (#240, open)
- Every inbox document normalizes to `legacy/source.json` — colliding across
  sessions and breaking the wiki's documented path. (#246 — fixed in this
  change: the normalized doc is written into its session automatically and the
  `legacy/` copy is named after the original file.)
- The documented manual step — `cp legacy/<doc>.json sessions/S001/
  transcript.json` — is exactly the kind of fragile, position-dependent
  surgery a first-run user shouldn't be asked to do. (Removed in this change:
  the legacy worker links the normalized doc as the session transcript
  itself.)

### Stage 4 — Search

**Intent:** `compost search "…"` returns ranked passages; hybrid when Ollama is
up, BM25 otherwise.

**Observed:** works as designed *once anything is indexed* — but every failure
upstream presents here first ("0 results") because search is where the user
finally has a question. The empty-index case should say *why* it's empty
(0 transcribed sessions ≠ 0 matches).

### Stage 5 — Chat

**Intent:** `compost chat "…"` answers from retrieved passages with verified
citations.

**Observed:** *"the model was not available on my Mac."* Three stacked causes:

1. The released CLI routed chat to the `synthesis` task → Anthropic → fails
   without an API key (#160 — fixed at HEAD: default task is the local
   `quick_chat`).
2. The seed's `config.toml` template routes tasks to model names nobody told
   the user about (`llama3.1:8b`, `qwen3:7b-instruct`, `claude-opus-4-7`), and
   nothing in the journey pulls them or checks them. `compost models doctor`
   knows precisely what's broken — but the journey never mentions it. The user
   hand-pulled `qwen3:1.7b` trying to guess the expected name.
3. Model routing lives per-seed, so fixing it in one seed fixes nothing for
   the next seed.

**Fix:** the wizard's model step — the user chooses local (wizard pulls a
small chat model and points `quick_chat`/`verification`/`synthesis` at it) or
cloud (wizard stores the API key in the keychain and leaves cloud routing),
and the choice is written to the seed template defaults so subsequent
`compost init` runs inherit it. `models doctor` is linked from the wizard
summary and the wiki.

### Stage 6 — Audio

**Intent:** drop the recording, get a diarized transcript.

**Observed:** requires the HF token *plus* license acceptance on two pyannote
repos — the journey's only hard third-party account dependency, discovered at
the worst time (after a 3-attempt burn, see Stage 3). The license check in
`setup` only runs when a token is already present, so the user never saw it.

**Fix:** the wizard prompts for the token at setup time, opens with the two
license URLs, and verifies both gated repos immediately with the token just
entered — the whole dependency resolves in one sitting, before any audio is
queued.

## Placement: what lives where (point 3 of the brief)

Three layers, three different lifecycles. The audit's conclusion is that the
current split is *mostly* right but implicit where it must be explicit:

| Layer | Contents | Lives | Verdict |
|---|---|---|---|
| Machine | transcriber venv, model weights, secrets | `~/.compost`, OS keychain, Ollama's store | **Keep.** These are heavy, host-specific artifacts. Moving them under `Seeds/` would make workspaces unportable and shareable seeds would leak credentials. |
| Workspace | which folder is a compost root; shared model routing | *implicit* (`<cwd>/Seeds` convention); routing duplicated per seed | **Change (follow-up).** Adopt an explicit marker (`Seeds/.compost-workspace.toml`) written by `init`: resolution walks up from cwd to the marker instead of trusting any `Seeds/` folder (#241); workspace-level `[defaults]` shared by every seed, seed config overrides. |
| Seed | sessions, transcripts, highlights, codes, themes, events, queue | `Seeds/<name>/` | **Keep the tree; fix the contents.** The per-seed layout matches the researcher's mental model and the filesystem-canonical promise. The fixes are: documents land *in their session* automatically (this change), queue/event paths become seed-relative so the folder survives a move (#240), and `legacy/` becomes an archive of originals' normalized copies rather than a load-bearing step in the pipeline. |

Renaming or flattening the seed tree itself was considered and rejected for
v0.2: every existing seed, the MCP tools, and the plugin skills bind to these
paths, and no observed failure traces to the tree's *shape* — they trace to
implicit conventions around it and manual steps inside it.

## The target journey

What the same field test looks like after this change plus the open follow-ups:

```
npm i -g @they-juanreina/compost-cli     # (#245 will warn when this goes stale)
compost setup                            # wizard: engine, models, HF token,
                                         #   chat choice — one sitting, all stored
mkdir -p ~/Research && cd ~/Research
compost init my-study
open Seeds/my-study/sessions/_inbox      # drop the PDF
compost watch --once                     # ingest → normalize → link → embed
compost search "…"                       # ranked passages, hybrid
compost chat "…"                         # local model, cited answer
# audio: drop the recording, watch --once — token + licenses already verified
```

Two manual steps survive: dropping files and running `watch`. Everything else
is either automatic or a confirmed one-keystroke fix inside the wizard.

## After setup: maintaining one item

The wizard above is gap-driven — it only surfaces a prerequisite when it's
*broken*, which is the wrong shape for a set-up install where a researcher needs
to **change** something already in place. The field test's sharpest example:
nothing in the journey let a user change, renew, or revoke their HuggingFace
token, and a *revoked* token read as `ok: set` while its 403 surfaced
misattributed to the pyannote license check (Stage 6) — so "renew" had no
trigger.

The fix is an item-addressable maintenance surface that the wizard and skill
both wrap:

```
compost setup item list                       # every check + the actions on it
compost setup item show hf-token --validate    # presence AND a live hf.co check
compost setup item run hf-token renew           # paste a new token, re-validated
compost setup item run hf-token forget           # drop the local copy (see below)
```

Two principles carried over from the audit:

- **Presence vs. validity are separate signals.** The canonical `compost setup`
  report stays presence-only and frozen (agents/CI gate on its JSON); the live
  `whoami` probe lives only on `setup item show --validate`, on demand. That is
  the trigger renew never had — a present-but-dead token now reads `live: fail`
  rather than masquerading as a license problem.
- **Credential lifecycle is two-sided, and named honestly.** `forget` removes
  only compost's *local* copy and points at `hf.co/settings/tokens` for the
  server-side delete it cannot do; if the token is a shell export it refuses to
  imply success. The wizard offers the same maintain step once the install is
  healthy, and `/compost-setup` hands these verbs to the user rather than
  touching secrets itself.
