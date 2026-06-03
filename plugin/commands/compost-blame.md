---
description: Show the three-actor provenance lineage of a compost artifact
allowed-tools: Bash(compost blame:*)
---

Run `compost blame <artifact>` for the artifact id (or `latest:<kind>=<seed>`) the user names, and explain the lineage chain: who created it (researcher / agent / ai), each update/endorse/reject, and the model + prompt hash for any AI-authored events.

Arguments: $ARGUMENTS
