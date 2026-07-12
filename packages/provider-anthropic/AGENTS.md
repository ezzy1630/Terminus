# @terminus/provider-anthropic — local rules

## Non-negotiable

- No `fetch` or HTTP client in this package. Only `renderRequest` and an
  `AnthropicTransport` interface.
- System fragments MUST go in the `system` field, not as user messages.
- Tool result content blocks MUST carry the originating `tool_use_id`.

## What NOT to add

- Direct SDK imports.
- API key reads from env.
