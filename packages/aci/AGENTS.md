# @terminus/aci — local rules

## Non-negotiable

- Tool definitions are versioned; a description change requires regression tests.
- A `ToolResult` envelope MUST be returned for every tool call; raw output never reaches the model.
- `status=success` MUST NOT be used when relevant output was silently dropped — use `partial` and set `truncation.occurred=true`.
- The `capability` tool is the only mechanism by which the model can change the active tool set; activation is logged as a cache event.
- `FakeToolExecutor` MUST NOT be wired into production code paths.

## What NOT to add

- Direct process / filesystem / network access — tool executors call the kernel via RPC.
- Provider-specific request bodies — provider renderers own wire translation.
- A `prompt` to "ask the model what to do" — surface a structured `NEEDS_USER_DECISION` instead.
