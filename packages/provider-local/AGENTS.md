# @terminus/provider-local — local rules

## Non-negotiable

- No `fetch` or HTTP client in this package. Only `renderRequest` and a
  `LocalTransport` interface.
- Tokenizer-based estimates are clearly fallbacks; prefer server-reported usage
  when available.

## What NOT to add

- Direct SDK imports.
- API key reads from env.
