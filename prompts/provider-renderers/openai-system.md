# OpenAI System Prompt Renderer

Terminus renders the compiled context into an OpenAI Chat Completions or
Responses API request. The renderer MUST follow these rules.

## Message ordering and cache prefixes

OpenAI caches a stable prefix of system + tool definitions + initial
messages. Terminus preserves cache hits by emitting:

1. `system` message — the authority layer (system.md + safety-rules.md),
   concatenated and never modified between turns of the same task.
2. `tools` array — the active tool schemas, sorted by a deterministic
   canonical order (alphabetical by tool id). The tool layer hash is
   logged as a cache event when it changes.
3. User/assistant turns — the volatile suffix.

The renderer MUST NOT reorder, merge, or split the system message between
turns. Any safety-rule update is a new task with a fresh cache.

## Tool schema dialect

OpenAI's tool schema is a strict subset of JSON Schema. The renderer:

- Emits `type` at the top of every object (OpenAI does not support
  `anyOf` at the parameter root — flatten to a union of string literals
  or split into multiple tools).
- Emits `enum` as an array of strings; OpenAI does not support numeric
  enums in tool parameters — convert to strings.
- Emits `description` on every leaf; OpenAI's quality depends on it.
- Does not emit `$ref`, `allOf`, `oneOf`, `if/then/else`, or
  `patternProperties` in tool parameters. The capability-registry
  flattens these before rendering.
- Emits `additionalProperties: false` on every object.
- Caps the total `tools` payload at 8192 tokens; larger palettes require
  progressive disclosure (capability cards first, full schemas on
  activation).

## Confidentiality filtering

The renderer consults the provider confidentiality policy
(`policies/organizations/default.yaml`) before emitting any content
fragment. Workspace-confidential fragments are stripped when the active
provider is not in `allowed_confidentiality.workspace`. Secret-adjacent
fragments are stripped unless the provider is `local`.

## Reasoning models

For `o1`-class models, the renderer:

- Does not emit a separate `system` role (these models do not accept it).
  The authority layer is prepended to the first user message instead.
- Does not emit `temperature`, `top_p`, or `frequency_penalty`.
- Emits `reasoning_effort` from the model profile.
- Surfaces `reasoning_tokens` from the response into the manifest as
  `provider.reasoning_tokens`.

## Continuation and compaction

OpenAI does not expose native continuation. Terminus emulates continuation by
appending a synthesized assistant turn ending with a continuation marker,
then a user turn instructing the model to continue. Native compaction is
not used; Terminus checkpoints and rebuilds the context.

## Streaming

The renderer streams `delta` events. Tool-call deltas are accumulated
into a single `tool_calls` array per assistant turn. Partial tool calls
are NOT settled until the model emits `finish_reason: tool_calls`.

## Cost accounting

The renderer records `prompt_tokens`, `completion_tokens`,
`cached_prompt_tokens`, and `reasoning_tokens` (when present) into the
provider attempt record. Cost is computed from the org's price table.
Cached tokens are billed at the cached rate; reasoning tokens at the
reasoning rate.

## Failure modes

- `context_length_exceeded` — surface to the Context Compiler, which
  triggers compaction or fragment eviction.
- `tool_schema_invalid` — fail the turn; the capability registry is
  expected to have pre-flattened.
- `rate_limited` — surface to the model broker for fallback.
