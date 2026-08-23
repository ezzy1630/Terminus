# @terminus/context-compiler

The Context Compiler (SPEC §8, §33). The principal intelligence layer that
decides, before every provider attempt: what authority/task/policy applies,
what world state changed, what code/tests/docs/evidence are relevant, which
episodes and memories to include, which tools/capabilities are visible, how
much capacity to reserve, and how to render all of the above for the chosen
provider.

## Public API

- `compileContext(input: CompileInput): Promise<CompiledContext>` — the main
  entrypoint. Returns the rendered request, manifest, warnings, omissions,
  token-budget outcome, and optional request artifact.
- `CompileInput`, `CompiledContext`, `ContextStore` interfaces.
- Retrieval: `RetrievalPipeline`, `RetrievalQuery`, `RetrievalResult`,
  `RetrievalMethod`, `deriveRetrievalQueries`, `deduplicateAndExplain`,
  `deduplicateAndValidate`, `LexicalRetrieval`, `DeterministicRetrieval`
  (explicit empty fallback for fixture-only callers).
- Evidence: `EvidenceCoverageMatrix`, `EvidenceGap`, `buildEvidenceCoverage`.
- Scoring: `ScoredCandidate`, `ScoringWeights`, `DEFAULT_WEIGHTS`,
  `scoreCandidates`.
- Budget: `AllocationOptions`, `AllocationResult`, `allocateBudget`.
- Cache: `planCacheEpoch`.
- Replay and compaction: `replayContext`, `replayWithAblation`,
  `compactContext`.

## Invariants

- The manifest MUST be durable before the provider request begins.
- Hard-required fragments (authority ≥ 80) bypass scoring.
- Complete episode integrity is preserved (a tool_call episode always includes
  both call and settled result).
- The compiler MUST NOT silently pretend evidence coverage exists.
- Every candidate, query, omission, transform, confidentiality decision, and
  memory decision is recorded in the manifest decision record.
- Over-hard-limit context fails before provider rendering; no truncation is
  implicit.
- No direct DB writes — accept a `ContextStore` interface.
