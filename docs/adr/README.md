# Architecture Decision Records

Point-in-time decisions with their context and consequences — distinct from the living design docs in [`docs/`](../). An ADR is amended by a later ADR, not edited in place (typo/factual-correction commits excepted; substantive amendments get an **Amended by** header line).

Status vocabulary: **Proposed** (under discussion) · **Accepted** (the decision; may carry amendments) · **Superseded by NNNN**.

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-codebook-multiplicity.md) | Codebook multiplicity (1:n codebooks per Seed) | Accepted |
| [0002](./0002-category-tier.md) | Category tier (second-cycle / pattern-coding layer) | Accepted |
| [0003](./0003-interfaces-monorepo-plugin-tauri.md) | Interfaces: monorepo, plugin-first, Tauri-wrap for native | Accepted |
| [0005](./0005-reference-key-and-rename-model.md) | Reference key & rename model (slugs cosmetic, artifact_id is the FK) | Accepted (impl deferred) |
