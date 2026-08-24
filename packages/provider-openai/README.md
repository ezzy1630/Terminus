# @terminus/provider-openai

OpenAI chat-completions renderer. Maps canonical context → OpenAI Chat
Completions API format. Handles tool schemas (function calling), system
messages, cache control headers, continuation IDs (previous_response_id),
reasoning summaries. Strict exact-prefix behavior for cache.

No actual fetch — exposes `renderRequest(input)` returning a serializable
request body. HTTP is delegated to an `OpenAiTransport` interface.

## Public API

- `OpenAiRenderer` — implements `ProviderRenderer`.
- `OpenAiTransport` — interface for the HTTP transport (supplied by adapter).
- `renderRequest(input)` — convenience helper.
- `OPENAI_MODEL_PROFILES` and `OPENAI_RENDERING_PROFILES`: concrete catalog
  data owned by this adapter.
- Wire types: `OpenAiChatMessage`, `OpenAiToolCall`, `OpenAiToolSchema`,
  `OpenAiRequestBody`.

## Invariants

- Exact fragments precede volatile fragments so prefix caching rewards the
  ordering.
- Tool schemas are emitted in deterministic order.
- `store: false` is set when provider policy retention mode is `organization_zdr`.
