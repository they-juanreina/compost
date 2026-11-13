# retrieval

LanceDB embeddings index, BGE-M3 via Ollama, BM25 + dense hybrid with Reciprocal Rank Fusion, bge-reranker-v2-m3, citation enforcement (Anthropic Citations API native; validator fallback for other providers).

Opt-in native-LanceDB write-path test (skipped by default; needs the installed binary): `COMPOST_LANCEDB_IT=1 pnpm --filter @they-juanreina/compost-retrieval test`.

See [ROADMAP.md § Retrieval](../ROADMAP.md#retrieval--chat-with-the-seed-grounded-with-citations).
