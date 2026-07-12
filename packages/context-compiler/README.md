# @forge/context-compiler

The Context Compiler (SPEC §8, §33). The principal intelligence layer that
decides, before every provider attempt: what authority/task/policy applies,
what world state changed, what code/tests/docs/evidence are relevant, which
episodes and memories to include, which tools/capabilities are visible, how
much capacity to reserve, and how to render all of the above for the chosen
provider.

## Public API

- `compileContext(input: CompileInput): Promise<CompiledContext>` — the main
  entrypoint. Returns `{ rendered, manifest, warnings, omitted }`.
- `CompileInput`, `CompiledContext`, `ContextStore` interfaces.
- Retrieval: `RetrievalPipeline`, `RetrievalQuery`, `RetrievalResult`,
  `RetrievalMethod`, `deriveRetrievalQueries`, `deduplicateAndValidate`,
  `DeterministicRetrieval` (fake).
- Evidence: `EvidenceCoverageMatrix`, `EvidenceGap`, `buildEvidenceCoverage`.
- Scoring: `ScoredCandidate`, `ScoringWeights`, `DEFAULT_WEIGHTS`,
  `scoreCandidates`.
- Budget: `AllocationOptions`, `AllocationResult`, `allocateBudget`.
- Cache: `planCacheEpoch`.

## Invariants

- The manifest MUST be durable before the provider request begins.
- Hard-required fragments (authority ≥ 80) bypass scoring.
- Complete episode integrity is preserved (a tool_call episode always includes
  both call and settled result).
- The compiler MUST NOT silently pretend evidence coverage exists.
- No direct DB writes — accept a `ContextStore` interface.
