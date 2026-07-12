# ADR-0028: Semantic index implementation

- **Status:** OPEN
- **Date:** 2025-07-11
- **Decision owner:** ACI owner
- **Supersedes:** none
- **Related:** SPEC §11.4, §34.6, §49.5, §26.5

## Context

Lexical search (FTS5, BM25) is the default retrieval mechanism (SPEC §34.6). It is fast, deterministic, and token-efficient. But for some queries — "find the function that handles authentication failures" — lexical search may miss semantically relevant but lexically different results.

Semantic search (embeddings + vector index) could improve retrieval, but: (1) universal semantic embeddings of every repository file is a non-goal for the first production release (SPEC §26.5), (2) embeddings add a dependency, storage cost, and privacy concern (sending code to an embedding service), (3) the value of semantic search over lexical+AST is unproven for Forge's cohorts, (4) SPEC §49.5 lists "semantic embedding index" as deliberately experimental.

We need to decide: which (if any) semantic index to support, when to use it, how to integrate it with the retrieval pipeline, and how to evaluate it.

## Decision (OPEN)

This ADR is OPEN. The experiment owner is the ACI owner. The decision will be made after M5 (SPEC §48.8) ships lexical+AST retrieval and M6 (SPEC §48.9) ships the Context Compiler, with ablation data on whether semantic retrieval improves outcomes.

Candidate implementations under evaluation:

1. **Local embeddings (e.g., MiniLM, BGE)** — privacy-preserving, local inference. Storage cost (vector index per workspace). Privacy: embeddings stay local.
2. **Provider embeddings (OpenAI, Cohere, etc.)** — higher quality, but sends code to a third party. Privacy concern; behind a gate.
3. **Hybrid (local for broad, provider for narrow)** — balance.
4. **No semantic index** — lexical+AST only. The baseline (ADR-0025).

Selection criteria:
- Retrieval quality (recall, precision) on target cohorts.
- Cost (inference time, storage).
- Privacy (local vs. provider).
- Maintenance burden (model updates, index rebuilds).
- Promotion gate: non-inferiority on safety; improvement on primary metric; no unacceptable regression on other cohorts (ADR-0025).

The semantic index, if chosen, would be behind a flag (not default) until its gate passes.

## Alternatives

- **Semantic index on by default.** Rejected (SPEC §26.5, §49.5): unproven; privacy concern; cost.
- **Provider embeddings without gate.** Rejected (SPEC §36.18): confidentiality violation.
- **No research.** Rejected: semantic retrieval may genuinely help; should be evaluated.

## Consequences (once an implementation is chosen)

- The chosen implementation lives in `crates/forge-code-intel` (or a new crate).
- The retrieval pipeline (`packages/retrieval`) integrates it as a candidate source alongside lexical and AST.
- The vector index (if any) is stored separately from SQLite (e.g., LanceDB, Qdrant, or in-process HNSW).
- The flag-gated feature is benchmarked against lexical+AST only (ADR-0025).

## Security Impact

Medium. Provider embeddings send code to a third party (confidentiality concern, SPEC §36.18). Local embeddings avoid this but add a dependency. Embeddings of secret-adjacent content must respect confidentiality labels.

## Evaluation Plan

- Retrieval ablation: lexical vs. lexical+AST vs. lexical+AST+semantic on target cohorts (SPEC §48.9).
- Cost: inference time, storage per workspace.
- Privacy: trace what is sent where (for provider embeddings).
- Promotion gate per ADR-0025.

## Migration

The semantic index, if chosen, is introduced after M6 (SPEC §48.9) and behind a flag. Promotion to opt-in requires the gate.

## Rollback

If semantic retrieval causes regression on a cohort, disable it (fall back to lexical+AST). The minimal baseline (ADR-0025) does not use semantic retrieval. Do not silently re-enable a regressing semantic index.
