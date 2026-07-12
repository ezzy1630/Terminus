# @terminus/provider-google — local rules

## Non-negotiable

- No `fetch` or HTTP client in this package. Only `renderRequest` and a
  `GoogleTransport` interface.
- System fragments MUST go in `systemInstruction`, not as `contents`.
- `cachedContent` references are lifecycle-managed outside this renderer.

## What NOT to add

- Direct SDK imports.
- API key reads from env.
