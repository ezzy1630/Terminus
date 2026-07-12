# ADR-0018: MCP as isolated capability source, not trust boundary

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** ecosystem owner
- **Supersedes:** none
- **Related:** SPEC §12.2, §35.3, §3.6

## Context

The Model Context Protocol (MCP) is a valuable interoperability protocol: it lets servers expose tools, resources, and prompts to clients. But the MCP spec itself says tool descriptions should be treated as untrusted unless obtained from a trusted server, and notes that protocol-level enforcement is insufficient (SPEC §3.6). Recent tool-poisoning research demonstrates both single-tool and distributed multi-tool attacks (SPEC Appendix B).

Terminus cannot treat MCP as a trust boundary. MCP servers are Z4 untrusted. Their tool descriptions, outputs, and metadata must be taint-tracked, capability-scoped, and reauthorized on change.

## Decision

Adopt **MCP as an isolated capability source, not a trust boundary** per SPEC §12.2, §35.3, §3.6:

1. **Descriptor pinning** — MCP server identity, version, and descriptor hashes are pinned. Changes require reauthorization (SPEC §35.3).
2. **Out-of-process isolation** — MCP servers run in separate processes with declared capabilities. No in-process MCP execution (SPEC §35.3).
3. **Per-tool capability classification** — every MCP tool is classified by effect class (SPEC §27.3) and scoped to a capability. The model cannot invoke an MCP tool without an active capability grant.
4. **Taint tracking** — MCP tool descriptions and outputs are taint-tracked (Z5 untrusted). Taint propagates into downstream policy decisions (SPEC §36.15).
5. **Reauthorization on change** — if a server's descriptor changes (new tool, changed schema), all active capabilities are revoked pending reauthorization (SPEC §35.3).
6. **No ambient authority** — MCP servers do not inherit the host's ambient authority. They get only their declared capabilities.
7. **Output limits** — MCP tool output is size-limited and artifact-backed (SPEC §35.3).
8. **Aggregate tool set hashing** — the aggregate tool set (all active MCP tools) is hashed and recorded in the context manifest (ADR-0010).

Implementation: `packages/extension-host` + `crates/terminus-extension-runtime`. Schemas: `schemas/capabilities/mcp-server.json`.

## Alternatives

- **Trust MCP servers by default.** Rejected (SPEC §3.6, §49.6): tool-poisoning attacks; distributed-tool-poisoning attacks; rug-pull attacks.
- **In-process MCP execution.** Rejected (SPEC §49.6): violates non-bypassability; no isolation.
- **All MCP tools loaded into every request.** Rejected (SPEC §49.6): token bloat; model confusion; attack surface.
- **MCP as the only tool source.** Rejected: Terminus built-in tools (ADR-0012) are first-class; MCP is one source among many.

## Consequences

- MCP servers are activated via the `capability` tool (ADR-0012), not loaded by default.
- Descriptor changes trigger reauthorization (visible in the UI per §35.11 discrepancy model).
- MCP tool output is taint-tracked and may be redacted (ADR-0016).
- The aggregate tool set hash is in every context manifest.

## Security Impact

Critical. MCP tool poisoning is a known attack class (SPEC §3.6, Appendix I.1). The non-bypassability tests (SPEC §27.4) include MCP server bypass attempts. The security evals (`evals/security/mcp-poisoning.yaml`) test single-tool and distributed-tool attacks.

## Evaluation Plan

- Malicious descriptor tests: poisoned tool description is detected; capability revoked.
- Rug-pull tests: descriptor change triggers reauthorization.
- Distributed-tool-poisoning tests: two innocent-looking tools combine to cause unauthorized effect; taint tracking catches it.
- Isolation tests: MCP server process cannot escape its sandbox.
- Reauthorization tests: changed descriptor revokes active capabilities.

## Migration

MCP support is introduced in M9 (SPEC §48.12). OpenCode's MCP integration is wrapped behind the Terminus capability registry (ADR-0002).

## Rollback

If an MCP server proves malicious, revoke and quarantine it (incident process, `docs/runbooks/compromised-extension.md`). If the MCP spec changes incompatibly, fork the loader. Do not silently re-enable a quarantined server.
