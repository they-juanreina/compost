# Design: `codebook duplicate | merge` (was `merge | fork | import`) + the qualified code ref

Status: **design note** · Original: 2026-06-12 · **Verb vocabulary revised: 2026-06-13** · Issue: [#269](https://github.com/they-juanreina/compost/issues/269) · Depends on: [ADR 0001 — Codebook multiplicity](./adr/0001-codebook-multiplicity.md) · Grounding: the methodology library (Saldaña 2013; DeTAILS / Sharma, Cochrane & Wallace 2025; Haraway 1988; Escobar 2018)

> **Filename note:** kept as `design-codebook-merge-fork-import.md` for link stability; the verbs it specifies are now **`duplicate` and `merge`** (see "Verb vocabulary" below).

The slice-1 verb surface shipped three honest stubs — `codebook merge | fork | import` (`cli/src/commands/codebook.ts`). Un-stubbing them forced a data-model decision (the qualified code ref) **and** a vocabulary decision (what the verbs should be called). The ref decision was settled and the foundation shipped in [#289](https://github.com/they-juanreina/compost/pull/289). The vocabulary decision is settled here: **three verbs collapse to two — `duplicate` and `merge`.**

## Verb vocabulary (revised 2026-06-13 — grounded in the methodology library)

The original three verbs were `fork`, `merge`, `import`. Reviewing them against the actual qualitative-coding literature (the alignment mandate — see the grounding library) produced three findings:

1. **`fork` and `import` are the same operation.** Both make an *independent copy of a codebook as a new lens*; they differ only in **where the source lives** (this seed vs. another seed) — a parameter, not a different intent. A researcher thinks *"give me my own copy of this lens to evolve,"* not *"am I forking or importing?"* Splitting that into two verbs is the "synonym for an existing thing" CLAUDE.md §7 calls a bug. → collapse to one verb, **`duplicate`**, with source as a flag (`--from <seed>:<codebook>` for the cross-seed case).

2. **`merge` is the field's actual term and stays.** Saldaña: *"some codes will be **merged together** because they are conceptually similar"* (p.207, quoting Lewins & Silver). DeTAILS: *"create new themes, **merge** or rename them"* (§3.5). CollabCoder (cited in DeTAILS §2.1): coders *"reconcile their codes through system-supported discussion and **merging**."* `merge` is the canonical verb for "combine conceptually similar units" across both the foundational manual and current AI-QDA practice. (Saldaña's cousins — *lump / collapse / condense / subsume / consolidate* — name the same motion; `merge` also matches the CAQDAS convention.)

3. **`diverge` / `converge` were considered and rejected as command names.**
   - **`converge` is already taken** with a *different* meaning: Saldaña p.35 defines *"interpretive convergence (the percentage at which different coders agree…)"* — an **inter-coder agreement** measure, which compost already exposes as `compost agreement` (κ/α). Naming a structural fold `converge` would collide head-on with the agreement concept.
   - **`diverge` has no methodological basis** — it appears nowhere in Saldaña (Ch.1/4/5 or the glossary) as a code operation; it's design-thinking vocabulary, not QDA. By Young (2007), *Mental Models* (align design to the user's existing mental model), a researcher doesn't "diverge a codebook."
   - The diverge/converge *framing* is a fine way to **describe** the two motions in prose; it must not be the verb names.

**Why compost has to coin `duplicate` at all:** Saldaña's tradition assumes **one evolving codebook per analyst** (*"data are not coded — they are recoded,"* p.206; *"the number of codes should become less, not more,"* p.208) and team coding *converges toward a single shared* master codebook maintained by a "codebook editor" (p.34). The canon has **no verb for deliberately maintaining multiple parallel lenses** — because it doesn't do that. That move is grounded instead in **Haraway's situated knowledges** (partial, standpoint-bound perspectives held at once) and **Escobar's pluriverse** (many worlds, not one), which is exactly ADR 0001's codebook multiplicity. So `duplicate` is a *necessary coinage* for a capability the classic literature lacks — and "duplicate/copy" is Saldaña-neutral (no term to collide with), unlike `fork` (git-flavored) or `diverge` (rejected).

**Decision:** verbs are **`duplicate`** (the old `fork` + `import`) and **`merge`**. Cross-seed copy is `duplicate --from <seed>:<codebook>` (name-once); `import` is **not** added as a synonym (CLAUDE.md §7), only documented as the NVivo/ATLAS.ti term it maps to, for discoverability.

## The collision (why this isn't additive)

A code lived at `codebook/<slug>.md`, addressed by its slug; its human id was `C-<slug>` (`createCode`, `cli/src/lib/artifacts.ts`). The path and the id both assume **one `distrust` per seed**. Every cross-frame operation breaks that:

- **`duplicate` (same-seed, was `fork`)** — copy an existing codebook's codes into a new lens *over the same seed*. The copy goes into a new frame dir, so no collision *if* codes are namespaced by codebook.
- **`duplicate --from` (cross-seed, was `import`)** — bring a codebook from another seed in as a shareable frame. The imported `distrust` would collide with a local `distrust` under a flat layout.
- **`merge`** — fold codebook A into codebook B. If both coded `distrust` under their own lens, the two are *distinct codes with the same name* — merging must keep both addressable, not silently overwrite. **This is the one case Option A doesn't fully erase** (see the merge wrinkle).

ADR 0001 anticipated this: **events carry `codebook_id` from day one**, so the provenance log can always tell two same-named codes apart. What was missing was a *reference* form — how a highlight, theme, category link, or CLI argument names "the `distrust` in `CB-epistemology`" vs "the `distrust` in `CB-pluriversal-justice`." That is the qualified `(codebook_id, code_id)` ref, now shipped.

## What references a code (the blast radius — handled by #289)

Any ref scheme change had to be honored by every reader that resolves a code id:

| Consumer | How it refs a code | File |
|---|---|---|
| code file on disk | `codebook/<CB-slug>/<slug>.md` | `artifacts.ts` |
| theme evidence | `evidence: [code:C-x:CB-…]` (post-#266) / legacy `codes[]` | `themes.ts`, `saturate.ts` |
| category links | `link(code → category)` payload `{code: C-x}` | `categories.ts` |
| recode / agreement | `C-x` in link events, κ/α by code | `recode.ts`, `agreement.ts` |
| blame / endorse | resolves `C-x` create event | `artifacts.ts` |
| retrieval metadata | `code_ids: [C-x]` on chunks | `retrieval`, #275 |

All now route through `resolveCodeRef` (`cli/src/lib/codeRefs.ts`), so `duplicate`/`merge` can't silently mis-attribute coverage and provenance.

## Ref scheme (decided — Option A, shipped in #289)

**Namespaced id + path.** Code files live at `codebook/<CB-slug>/<code-slug>.md`; the canonical human id is `C-<cb-slug>/<code-slug>`. The frame is *in* the id, so cross-frame collisions are impossible by construction; a bare `C-<slug>` is accepted as shorthand and resolved against its frame (error-and-list when ambiguous). The trade-off (a seed-wide migration of every `C-<slug>` ref) was paid by `compost codebook migrate-ids` (dry-run-first). *(Options B "qualify lazily on collision" and C "always-compound, flat storage" were considered and rejected — see git history of this note for their pros/cons.)*

## Verb semantics (revised)

- **`duplicate <source> <new-name>`** *(was `fork`; with `--from <seed>:<codebook>`, was `import`)* — create codebook `CB-<new-name>` (copy stance/description), then for each non-archived code in `<source>` emit `create(code, …, codebook_id=CB-<new-name>)` with a fresh artifact id and an `inputs` link to the origin code for `blame` lineage. **Definitions + lineage travel; coded instances (evidence) do not** — see below. Category links are **not** copied (a duplicate is a fresh second-cycle pass).

- **`merge <from> <into>`** — re-emit each of `<from>`'s codes as belonging to `<into>` (an `update(codebook_id)` event, **preserving artifact identity + history**, so their existing local evidence stays attached), then **reject-archive** `<from>` (never delete — `reject` archives, ADR 0001). Colliding names are **kept distinct** (never silently fused); coverage math (`saturate`, `agreement`) treats the two as distinct until the researcher explicitly de-dups. See the merge wrinkle.

### Evidence semantics (why "evidence doesn't travel" is correct, not a limitation)

A highlight anchors to *a specific utterance in a specific corpus* (`span 0–16 of U-0002 in S001`). That anchor is meaningless in another seed, and copying it would produce a dangling pointer — not evidence. So:

- **`duplicate` copies definitions + lineage, never coded instances — regardless of source.** Cross-seed *can't* bring instances (the highlights live elsewhere); same-seed *shouldn't* (copying instances would let the "independent second lens" silently inherit the first lens's coding decisions, defeating the reason to duplicate — if you wanted to keep the coding you'd edit the codebook in place, history preserved via events). A duplicated code enters **un-grounded** and must earn its grounding by being coded against the local data. This is the rigorous stance: a borrowed code is a *hypothesis in your corpus* (framework/deductive coding — Ritchie & Spencer), and it correctly shows **zero local saturation** until re-grounded, never inheriting the source study's saturation (a category error). compost's `[draft]`/grounding model already expresses "present as a frame, not yet evidenced here."

- **`merge` preserves instances** — because it re-homes *existing local codes* with their identity intact (`update(codebook_id)`), and those highlights were always in this seed.

The asymmetry is the point: **diverge starts empty and earns grounding; converge keeps the accumulated coding.** (DeTAILS §7.3 independently observes researchers vary in "merging strategies" *within* one codebook — consistent with merge preserving, duplicate not.)

## Decisions (maintainer)

| # | Question | Decision |
|---|---|---|
| 0 | **Verb names** (2026-06-13) | **`duplicate` + `merge`.** `fork`+`import` collapse to `duplicate` (source is a flag); `merge` kept (field's term); `diverge`/`converge` rejected (`converge` collides with inter-coder *agreement*; `diverge` is not a QDA operation). |
| 1 | Ref scheme | **A — namespaced id + path** (shipped #289). `codebook/<CB-slug>/<code-slug>.md`; id `C-<cb-slug>/<code-slug>`; bare `C-<slug>` shim. |
| 2 | `duplicate` (was `fork`/`import`) | **Branch-copy definitions + lineage**; evidence does **not** travel (re-grounded locally); category links not copied. |
| 3 | Cross-seed source | **`duplicate --from <seed>:<codebook>`** — name-once; `import` documented as the mapped NVivo/ATLAS.ti term, not added as a synonym. |
| 4 | `merge` collision policy | **Keep distinct** — same-named codes never silently fused; within-frame rename on the way in; de-dup is a later explicit action. |
| 5 | Bare-`C-slug` tie-break | **Error-and-list** when ambiguous across frames (mirrors `resolveCategory`). |
| 6 | Id uniformity | **Uniform — qualify everything** (shipped #289). Even `CB-primary` codes are `C-primary/<slug>`. |
| 7 | Packaging | **Foundation + migration in one PR** (#289, done), then separate verb PRs (`duplicate` → `merge`). |

## The merge wrinkle Option A does not erase

Option A removes cross-frame collisions, but **`merge` collapses two frames into one**, and within a single frame `codebook/<cb>/<slug>.md` is still one-slug-per-dir. So merging `CB-a` and `CB-b` when both coded `distrust` produces two codes that must coexist *in the same frame* — which the flat per-frame dir can't hold. With **keep-distinct**, `merge` must rename one on the way in (e.g. `distrust` ← from `CB-a`, `distrust-from-b` ← from `CB-b`) and record the rename in the event log so `blame` shows it. `merge` therefore remains the highest-risk verb: it touches coverage math (`saturate`/`agreement` see two distinct codes) and needs the within-frame disambiguation rule.

## Build plan (dedicated follow-up)

Foundation (steps 1–2) shipped in #289. Remaining, sequenced to keep each step reviewable:

1. ~~`resolveCodeRef` choke point~~ — **done (#289)** (`cli/src/lib/codeRefs.ts`; every consumer threaded through it).
2. ~~Storage migration~~ — **done (#289)** (`compost codebook migrate-ids`, dry-run-first; bare-ref shorthand shim).
3. **`duplicate`** — branch-copy into a new frame dir; covers both same-seed and `--from <seed>:<codebook>`; definitions + lineage only (evidence re-grounded locally). Lowest risk (new frame dir → no collision).
4. **`merge`** — highest risk: within-frame disambiguation rename + coverage math.

Each step gets the same adversarial review + regression tests as the rest of the milestone. **The kill filter was run on a real two-lens study** ([`dogfood-edges-ecotones-duplicate-merge.md`](./dogfood-edges-ecotones-duplicate-merge.md), 2026-06-13): the capability passes filters 1–3 (novel, not-the-analyst, CLI-doable) and the consumers (`agreement`/`saturate --codebook`, cross-lens themes) shipped, but filter #4 came back *grounded-but-not-demonstrated* — the single real study never organically reaches for the verbs (it lacks a second corpus for `duplicate --from` and a coding team for `merge`). The maintainer made the explicit call to build both anyway, judging the methodology grounding + ready consumers sufficient. `duplicate` is the clean first PR; `merge` follows.

## Why this stayed a design note

Un-stubbing these verbs without settling the ref scheme would have baked a guess into every code-referencing consumer — the genuinely ambiguous data-model decision that warranted the maintainer's call. The ref scheme is now settled (#289) and the vocabulary is settled here; the verbs themselves remain gated on a validated need.
