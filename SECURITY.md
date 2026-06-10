# Security policy

## Reporting a vulnerability

Email **juanwkreina@gmail.com** with the subject `[security] compost`.

Please include:
- The version (output of `compost --version` or the npm tag / git SHA).
- A reproduction — minimum repro code, a tarball, or repo link.
- The impact you observed (or believe is achievable).
- Whether you'd like attribution in the fix's release notes.

I aim to acknowledge within 72 hours and ship a fix or a coordinated disclosure
within 30 days for HIGH-severity, 90 days for everything else. If you don't
hear back within 72 hours, please ping again — email filters occasionally
sweep these into spam.

GitHub Security Advisories are also fine if you prefer that channel.

## Threat model

Compost is a **local-first researcher tool**. The intended deployment is:

- One user, one laptop. Seeds live under `Seeds/` in the user's projects.
- An optional MCP host (Claude Code, etc.) connects to the cli for read +
  mutation tool calls. Mutations land as `[draft]` until a researcher
  endorses them — a human approval gate sits between AI suggestion and
  endorsed truth.
- Optional local LLM (Ollama) for `chat`. No outbound network calls in the
  core loop unless the user configures a cloud provider.
- An optional native transcriber service on `localhost:7862` (or Docker
  fallback).
- A CI pipeline that publishes to npm on tag push.

Compost is **not** intended to run as a multi-tenant service or to ingest
hostile content under attacker control. If your use case differs, the
hardening notes below still apply, but expect additional gaps.

### In-scope concerns

- Code execution from a poisoned npm install (supply chain).
- Path traversal via `--seed` or ingest paths that escape the user's seed
  tree.
- Prompt injection in transcript content that subverts the chat
  system-prompt's "answer ONLY from context" constraint.
- AI-via-MCP performing mutations the user didn't approve.
- Secret leakage from CI logs or error messages.
- Integrity of the event ledger (`events.sqlite`) under concurrent or
  adversarial writes.

### Out of scope

- Defending the user's machine against the user themself running `compost`
  with hostile arguments after copy-pasting from a malicious tutorial. We
  validate inputs where it's cheap (e.g. seed name shape) but the local
  cli is trusted with whatever the user's shell hands it.
- Multi-tenant isolation. Don't run compost as a hosted service.
- Cryptographic confidentiality of corpus content at rest. `events.sqlite`
  is not encrypted; transcripts are plain JSON. Use OS-level disk
  encryption (FileVault / LUKS / BitLocker).

## Supported versions

Security fixes target the latest minor (`0.1.x`). When a `0.2.0` ships,
`0.1.x` will receive security backports for **90 days** beyond the
`0.2.0` release date.

| Version | Security fixes |
|---|---|
| 0.1.x (current) | Yes |
| 0.0.x (pre-release) | No — please upgrade |

## v0.1.0 security audit (2026-06-05)

A multi-dimension audit ran on v0.1.0 covering: dependency surface,
trust boundaries, injection (command/path/SQL/prompt/JSON), authorization
gates, secret handling, supply chain, native modules, filesystem safety,
and licenses. Each candidate finding was adversarially verified through
two independent lenses (exploitability + false-positive bias) before
filing. 5 confirmed findings, surfaced as GitHub issues:

| Severity | Issue | Status |
|---|---|---|
| HIGH | [#210](https://github.com/they-juanreina/compost/issues/210) — Pin third-party Actions to SHAs (NPM_TOKEN co-residency) | open, v0.1.2 |
| MEDIUM | [#211](https://github.com/they-juanreina/compost/issues/211) — Validate `--seed` name + assert Seeds/ containment | open, v0.1.2 |
| LOW | [#212](https://github.com/they-juanreina/compost/issues/212) — Ingest walk follows symlinks via statSync | open, v0.1.2 |
| LOW | Accepted risk — see "Known accepted risks" below | n/a |

Dependency surface at the time: **0 critical, 0 high** npm vulns; 1
moderate, 1 low. No accidentally-committed secrets confirmed (2 pattern
hits both verified as benign placeholders).

## Known accepted risks (v0.1.0)

### better-sqlite3 fetches a prebuilt native binary at install time

`better-sqlite3@^11.5.0` is the only package allow-listed for install
scripts (`pnpm.onlyBuiltDependencies` in the root `package.json`). Its
install script invokes `prebuild-install`, which downloads a prebuilt
`.node` binary from a GitHub release. The download is protected by TLS
but the pnpm lockfile does not record an integrity hash for the runtime
binary — only for the tarball of the install script itself.

A compromise of the WiseLibs (better-sqlite3 maintainer) GitHub releases
would deliver a malicious `.node` that loads into the cli process on
every `compost <cmd>` invocation. Probability is low (TLS + GitHub
release infra), but it's the one supply-chain link in this repo not
covered by pnpm's integrity model.

**Mitigation:** keep the dep pin tight (`^11.5.0`), stay current with
upstream security advisories, and revisit if this attack class becomes
widespread. Compiling from source on install would close the gap at the
cost of substantially worse install UX (`build-essential` / Xcode CLI
tools required), so we're not doing it today.

### NPM_TOKEN long-lived secret in CI

The release workflow uses a 90-day granular access token
(`NPM_TOKEN`, expires 2026-09-03). The token is scoped to
`@they-juanreina` with Bypass-2FA enabled (required for unattended
CI publish). Migration to npm Trusted Publishing (OIDC) is tracked at
[#208](https://github.com/they-juanreina/compost/issues/208) and will
remove this long-lived secret. Until then: token rotation is on the
calendar; the GitHub repo secret is the only place it's stored locally;
it does not exist on any maintainer machine.

## Storing your tokens

Compost needs two kinds of secret: a **HuggingFace token** (for the gated
pyannote diarization model) and, only if you route to a cloud LLM, a **provider
API key** (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Compost never writes a
raw secret into a seed, `config.toml`, or the event ledger — `config.toml`
stores only the *name* of an environment variable (`api_key_env = "ANTHROPIC_API_KEY"`),
never the value.

### Where compost looks (resolution precedence)

A secret is resolved by this order — the first hit wins:

1. **Environment variable** — `HUGGINGFACE_TOKEN` / `HF_TOKEN`, `ANTHROPIC_API_KEY`, … in `process.env`.
2. **OS keychain** — macOS Keychain (`security`), Linux Secret Service (`secret-tool`/libsecret).
3. **`~/.compost/secrets.env`** — a `0600` dotenv, **refused if its permissions are loose**.

The env var wins at resolution time because it's the explicit, per-invocation
override (CI, `direnv`, a one-off `HUGGINGFACE_TOKEN=… compost …`). That's
independent of *where you should store a secret at rest* (below).

### Where you should store it (recommended hierarchy)

1. **OS keychain (best)** — encrypted at rest, never a plaintext file. Use:
   ```sh
   compost secrets set HUGGINGFACE_TOKEN     # prompts via stdin; not in shell history
   printf %s "$TOKEN" | compost secrets set ANTHROPIC_API_KEY
   ```
   `compost secrets get <NAME>` prints the resolved value (for scripting),
   `compost secrets list` shows which secrets are set and where (never the
   value), and `compost secrets rm <NAME>` removes it.
2. **Per-user environment / `direnv`** — export it from your shell profile or a
   per-user `.envrc`. Good for CI and ephemeral shells.
3. **`~/.compost/secrets.env` (0600 dotenv)** — the fallback when no keychain is
   available (Windows, headless Linux without libsecret). `compost secrets set`
   writes it `0600` automatically; compost loads it into the environment at
   startup so the secret resolves everywhere an env var would, **without editing
   your shell profile**. An insecure (group/world-readable) `secrets.env` is
   *refused, not read* — fix it with `chmod 600 ~/.compost/secrets.env`.

### Hard rules

- **Never put a secret in `Seeds/` or `config.toml`.** Only the env-var *name*
  belongs in config (`api_key_env`). `Seeds/` holds interview content and is
  shared/synced; a token there is a leak.
- **Keep secret files `0600` and `~/.compost` `0700`.** `compost setup` warns
  (non-blocking) when it finds a group/world-readable secret file under
  `~/.compost`, with the exact `chmod` to fix it.
- **Don't commit a `secrets.env`.** `.env`, `.env.local`, and `secrets.env` are
  gitignored; keep it that way.

### Shared / multi-user machines

There is **no shared secret file**. Each user keeps their own token in their
own per-user keychain or per-user environment. A world-readable token file on a
multi-user box leaks to every account on it — don't create one. The
`~/.compost/secrets.env` fallback is per-user (under each user's home) and
enforced `0600`, so it's safe; a *shared* path pointed at by
`COMPOST_SECRETS_ENV` is not — never aim multiple users at one file.

### Where your HuggingFace token is sent

The token is sent as a `Bearer` credential **only to `huggingface.co`**, never to
a third party, and is never written into a seed, `config.toml`, or the event
ledger. Two call sites:

- **Transcription (diarization):** fetching the gated `pyannote` model files
  during an audio job.
- **`compost setup item show hf-token --validate`:** a single `GET
  https://huggingface.co/api/whoami-v2` to report whether the stored token is
  still live (revoked/expired tokens otherwise surface as a confusing pyannote
  403). This is on-demand only — it never runs in the read-only `compost setup`
  report or the core ingest/search loop, so the "no outbound calls unless you
  configure them" property of the core loop is preserved.

## Hardening notes for users

- **Don't run `compost` against a hostile transcript** and then chat with
  it through an MCP-connected AI without supervision. The chat system
  prompt instructs the model to answer only from context, but a
  determined prompt-injection inside the transcript can still subvert
  this. The mutation-confirmation gate the MCP host shows is your
  defense — read the args.
- **Set `COMPOST_USER` to your real identity** when working in a team —
  it ends up in `events.sqlite` as `actor_id` for researcher events. If
  you don't, the default falls back to `$USER` then `"researcher"`.
- **Don't commit `Seeds/`** — it's gitignored by default. Transcripts
  contain interview content.
- **Store tokens with `compost secrets`, not hand-rolled files** — see
  [Storing your tokens](#storing-your-tokens) for the keychain > per-user env >
  `0600` dotenv hierarchy. `.env.local`, `.env`, and `secrets.env` are
  gitignored; keep them that way. If a token leaks, rotate it via the provider
  dashboard (HuggingFace / Anthropic / OpenAI).
