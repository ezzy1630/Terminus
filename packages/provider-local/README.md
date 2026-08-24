# @terminus/provider-local

Local-model renderer. Chat-template-aware, tokenizer-aware. Same Transport
pattern as other providers (OpenAI-compatible local endpoint).

## Public API

- `LocalRenderer` — implements `ProviderRenderer`.
- `LocalTokenizer` interface and `WhitespaceTokenizer` default implementation.
- `LocalTransport` — interface for the HTTP transport.
- `renderRequest(input)` — convenience helper.
- `LOCAL_MODEL_PROFILES` and `LOCAL_RENDERING_PROFILES`: concrete catalog data
  owned by this adapter.
- Wire type: `LocalRequestBody`.

## Invariants

- Local servers typically don't expose native continuation; the renderer
  reports `requiresRerender: true` on continuation decisions.
- `extractUsage` falls back to tokenizer-based output token count when the
  server doesn't report usage.
