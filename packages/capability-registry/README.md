# @terminus/capability-registry

Capability descriptor, registry, lockfile, activation lifecycle. Per SPEC §12, §35.

## Public API

- `CapabilityRegistry` with `discover()`, `admit(descriptor)`,
  `activate(id, session, task)`, `deactivate(id)`, `revoke(id)`.
- `CapabilityRepository` interface for persistence.
- `CapabilityLockfile`, `LockfileEntry`, `lockfileEntrySchema`,
  `capabilityLockfileSchema`.
- `SkillManifest`, `skillManifestSchema`, `loadSkillManifest(yaml)`,
  `manifestToDescriptor(manifest, source, contentHash)`.

## Invariants

- A changed descriptor hash, schema, server version, package digest, or
  requested scope invalidates prior authorization. The capability is disabled
  until re-admitted.
- `verified_third_party` capabilities require a signature.
- Skills are loaded through a permission-checked capability path; skill scripts
  run through the kernel, never with ambient control-plane authority.
