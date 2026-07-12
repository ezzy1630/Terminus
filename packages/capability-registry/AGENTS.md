# @terminus/capability-registry — local rules

## Non-negotiable

- Pin descriptor hashes in the lockfile.
- Re-admission required on hash/schema/version/scope change.
- `verified_third_party` capabilities require a signature.
- Skill scripts run through the kernel, never with ambient control-plane
  authority.

## What NOT to add

- Direct filesystem reads of SKILL.md (caller supplies parsed YAML).
- In-process execution of third-party code.
