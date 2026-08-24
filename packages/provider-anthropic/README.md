# @terminus/provider-anthropic

Anthropic Messages API renderer. Maps canonical context to Anthropic Messages
API with system blocks, tool_use/tool_result content blocks, cache_control
breakpoints, and the `anthropic-version` header. Same Transport pattern as
other providers.

## Public API

- `AnthropicRenderer` — implements `ProviderRenderer`.
- `AnthropicTransport` — interface for the HTTP transport.
- `renderRequest(input)` — convenience helper.
- `ANTHROPIC_MODEL_PROFILES` and `ANTHROPIC_RENDERING_PROFILES`: concrete
  catalog data owned by this adapter.
- Wire types: `AnthropicRequestBody`, `AnthropicMessage`,
  `AnthropicContentBlock`, `AnthropicSystemBlock`, `AnthropicToolSchema`.

## Invariants

- System fragments go in `system` blocks (not messages).
- Tool_use/tool_result content blocks preserve their typed structure.
- Cache breakpoints use `cache_control: { type: "ephemeral" }`.
