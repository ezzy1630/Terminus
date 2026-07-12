# @forge/provider-openai — local rules

## Non-negotiable

- No `fetch` or HTTP client in this package. Only `renderRequest` and an
  `OpenAiTransport` interface.
- Exact fragments must precede volatile fragments for prefix caching.
- Never set `store: true` when policy retention mode forbids provider
  persistence.

## Style

- Map fragment kind → message role via a single function with a `default` case.
- Use `as const` for string literals in the request body.

## What NOT to add

- Direct SDK imports.
- Filesystem or environment access for API keys.
