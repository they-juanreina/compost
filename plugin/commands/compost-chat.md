---
description: Ask a grounded, citation-backed question of a compost seed
allowed-tools: Bash(compost chat:*), Bash(compost query:*)
---

Answer the user's question about the seed using `compost chat` (RAG-grounded). Every claim must carry a citation (utterance_id + verbatim quote). If retrieval is insufficient, say so rather than guessing.

Arguments: $ARGUMENTS
