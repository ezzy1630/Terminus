# @terminus/capability-registry

Capability descriptor, registry, lockfile, activation lifecycle. Per SPEC §12, §35.

## Public API

- `CapabilityRegistry` with `discover()`, `admit(descriptor)`,
  `activate(id, session, task)`, `deactivate(id)`, `revoke(id)`.
- Durable `LockfileStore` (`MemoryLockfileStore`, `FileLockfileStore`).
- Progressive skill discovery (`discoverSkills`, `loadSkillBody`) and
  `terminus.skill.yaml` / `forge.skill.yaml` validation with `skill_md_hash`.
- MCP admission (`admitMcpServer`, per-tool descriptor hashes, reauthorization).
- Isolated MCP relays (`McpProcessRelay`, `McpHttpRelay`) via `KernelProcessPort`.
- Skill script execution only through `executeSkillScript` + kernel grants.

## Invariants

- A changed descriptor hash, schema, server version, package digest, or
  requested scope invalidates prior authorization until re-admitted.
- `verified_third_party` capabilities require a signature.
- Skills load through a permission-checked path; scripts never get ambient
  control-plane authority.
- MCP descriptions/results are labeled untrusted.
