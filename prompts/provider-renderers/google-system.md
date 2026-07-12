# Google (Gemini) System Prompt Renderer

Forge renders the compiled context into a Google Gemini `generateContent`
or `streamGenerateContent` request. The renderer MUST follow these rules.

## Message ordering and cache prefixes

Google exposes implicit caching on a stable prefix. Forge preserves cache
hits by emitting:

1. `system_instruction` — the authority layer as a single `text` part.
   Forge never modifies the authority between turns of the same task.
2. `tools` array — the active tool schemas as `function_declarations`.
   Tool layer hash changes are logged.
3. `contents` — the volatile suffix as alternating `user` and `model`
   turns. Each turn is a `parts` array.

The renderer MUST NOT reorder, merge, or split `system_instruction`
between turns. Google's implicit cache is invalidated by any change
upstream of the cached prefix.

## Tool schema dialect

Google's `function_declarations` schema has stricter constraints than
OpenAI/Anthropic:

- Each function declaration has `name`, `description`, and `parameters`.
- `parameters` MUST be `type: "object"` with `properties` and
  `required`. Top-level `oneOf`/`anyOf` are NOT supported.
- Nested `oneOf`/`anyOf` are NOT supported. The capability registry
  flattens these into separate function declarations before rendering.
- `enum` is supported as a string array.
- `description` is required on every property.
- `$ref`, `allOf`, `if/then/else`, and `patternProperties` are NOT
  supported.
- Maximum 128 function declarations per request; Forge uses progressive
  disclosure beyond that.
- The renderer MUST emit `parameters: { type: "object", properties: {} }`
  (not `null`) for tools with no parameters.

## Confidentiality filtering

Same as OpenAI/Anthropic: the renderer consults the provider
confidentiality policy and strips workspace-confidential or
secret-adjacent fragments when the active provider is not approved for
that classification.

## Reasoning models

For `gemini-2.5-*` models with thinking enabled, the renderer:

- Emits `generationConfig.thinkingConfig: { includeThoughts: true,
  thinkingBudget: N }` from the model profile.
- Surfaces `thoughtsContent` into the manifest as
  `provider.reasoning_tokens` and redacts from the transcript by default.
- Emits `temperature`, `topP`, `topK` only when the profile sets them.

## Continuation and compaction

Google exposes `finishReason: "MAX_TOKENS"` for continuation. Forge
emulates continuation by appending a model turn ending at the stop, then
a user turn `Continue from where you left off.` Native compaction is
not used; Forge checkpoints and rebuilds.

## Streaming

The renderer streams `streamGenerateContent` SSE events. Function-call
deltas are accumulated into a single `functionCall` per model turn.
Partial function calls are NOT settled until the stream terminates with
`finishReason`.

## Cost accounting

The renderer records `promptTokenCount`, `candidatesTokenCount`,
`cachedContentTokenCount`, and `thoughtsTokenCount` from
`usageMetadata` into the provider attempt record. Cost is computed from
the org's price table.

## Failure modes

- `context_length_exceeded` — surface to the Context Compiler for
  compaction.
- `tool_schema_invalid` (400 with `INVALID_ARGUMENT`) — fail the turn;
  pre-flatten in the capability registry.
- `rate_limited` (429) — surface to the model broker for fallback.
