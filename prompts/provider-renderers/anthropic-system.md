# Anthropic System Prompt Renderer

Terminus renders the compiled context into an Anthropic Messages API request.
The renderer MUST follow these rules.

## Message ordering and cache prefixes

Anthropic caches a stable prefix of system + tools + initial messages when
`cache_control` breakpoints are set. Terminus preserves cache hits by emitting:

1. `system` array — the authority layer as a single text block with
   `cache_control: { type: "ephemeral" }`. Terminus never modifies the
   authority between turns of the same task.
2. `tools` array — the active tool schemas, with a `cache_control`
   breakpoint after the last tool. Tool layer hash changes are logged.
3. User/assistant turns — the volatile suffix. Terminus places a
   `cache_control` breakpoint after the most recent complete episode
   boundary so subsequent turns reuse the prefix.

The renderer MUST NOT reorder, merge, or split the system block between
turns. Anthropic's prompt cache is invalidated by any change upstream of
the breakpoint.

## Tool schema dialect

Anthropic's tool schema is close to JSON Schema but with constraints:

- Emits `input_schema` (not `parameters`) on each tool.
- Emits `type: "object"` at the input root.
- Does not emit `$ref`, `allOf`, `anyOf`, `oneOf`, `if/then/else`, or
  `patternProperties` in `input_schema`. The capability registry
  flattens these before rendering.
- Emits `description` on the tool and on every property.
- Supports `enum` as string arrays; numeric enums must be converted to
  strings.
- Caps the total `tools` payload at 8192 tokens.

## Confidentiality filtering

Same as OpenAI: the renderer consults the provider confidentiality policy
and strips workspace-confidential or secret-adjacent fragments when the
active provider is not approved for that classification.

## Reasoning models

For `claude-3-*` and `claude-4-*` models, the renderer:

- Emits `thinking: { type: "enabled", budget_tokens: N }` when the model
  profile enables extended thinking. The budget is drawn from the model
  profile, not the task budget.
- Surfaces `thinking` content blocks into the manifest as
  `provider.reasoning_tokens` and redacts them from the transcript by
  default (configurable).
- Emits `temperature` only when the profile sets it; default omits.

## Continuation and compaction

Anthropic exposes `stop_reason: "max_tokens"` for continuation. Terminus
emulates continuation by appending an assistant turn ending at the stop,
then a user turn `Continue from where you left off.` Native compaction
is not used; Terminus checkpoints and rebuilds.

## Streaming

The renderer streams `content_block_delta` events. Tool-input deltas are
accumulated into `tool_use` blocks per assistant turn. Partial tool inputs
are NOT settled until `message_stop`.

## Cost accounting

The renderer records `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, and `cache_read_input_tokens` into the
provider attempt record. Cost is computed from the org's price table.
Cache-read tokens are billed at the cached rate.

## Failure modes

- `context_length_exceeded` — surface to the Context Compiler for
  compaction.
- `tool_schema_invalid` — fail the turn; pre-flatten in the capability
  registry.
- `rate_limited` (429) — surface to the model broker for fallback.
