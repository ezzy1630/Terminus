# @terminus/provider-zen local rules

## Non-negotiable

- This package integrates the OpenCode Zen and Go model gateways only. Never
  import, execute, or depend on the OpenCode agent runtime.
- No `fetch`, filesystem access, environment access, or raw API keys.
- Unknown catalog entries and protocols fail closed.
- Every request binds one documented deployment, model, protocol, and path.
- Do not mark provider privacy claims as independently verified facts.

## Style

- Decode external JSON from `unknown`.
- Keep SSE parsing incremental and bounded.
- Emit complete canonical tool calls only after their streamed arguments parse.
