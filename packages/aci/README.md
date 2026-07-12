# @terminus/aci

Agent Control Interface for Terminus. Per SPEC §11 and §34.

Exports:

- `ToolDefinition` interface — versioned description of a tool (id, version, summary, use_when, do_not_use_when, input_schema, result_schema, side_effect_class, required_capabilities, trust_level, default_timeout, policy_tags).
- The 7 default always-visible tools as `ToolDefinition` constants: `READ`, `SEARCH`, `PATCH`, `EXEC`, `JOB`, `INSPECT`, `CAPABILITY` (§34.2).
- `ToolExecutor` interface and `ToolCallContext`.
- `ToolRegistry` — `register(def, executor)`, `get(toolId)`, `list()`, `listActive()`.
- `ToolResult<T>` — universal result envelope matching §34.4 (status, summary, data, artifacts, sourceVersions, truncation, diagnostics, sideEffects, trust, confidentiality, timing, resourceUsage, toolCallId, traceId).
- `ProgressiveDisclosure` — two-stage discovery (§11.2): `searchCards(query)`, `activate(capabilityId)`, `deactivate(capabilityId)`, `activeToolSet()`.
- `FakeToolExecutor` — for tests; returns scripted results.

The package does NOT execute effects. Tool executors delegate to the kernel via RPC. No `child_process`, `node:fs`, or network access.
