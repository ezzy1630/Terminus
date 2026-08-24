# ADR-0017: Agent Skills compatibility with Terminus manifest extension

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** ecosystem owner
- **Supersedes:** none
- **Related:** SPEC §12.1, §35.2

## Context

Agent Skills is an emerging standard (SPEC Appendix B) for declaring model-usable skills via `SKILL.md` + metadata. Skills are valuable: they let users and curators package reusable procedures (diff-apply, test-run, search-symbol, verification-plan, release-notes, database-migration-review) that the model can discover and invoke.

However, the upstream Agent Skills spec does not address Terminus's security requirements: capability declaration, provenance, hash pinning, model-visibility controls, or compatibility with the Terminus capability registry. We need to be compatible with the upstream format while extending it with Terminus-specific security metadata.

## Decision

Adopt **Agent Skills compatibility with a Terminus manifest extension** per SPEC §12.1 and §35.2:

1. **Upstream compatibility** — skills are discovered and loaded using the upstream Agent Skills format (`SKILL.md` + frontmatter). Existing skill repos work without modification.
2. **Terminus manifest extension** — `terminus.skill.yaml` alongside `SKILL.md` declares: `id`, `version`, `compatible_harness`, `required_capabilities` (filesystem/network/secrets/subprocesses scope), `tests`, `provenance`, `skill_md_hash` (sha256 of the SKILL.md body), `trust_level`.
3. **Permission-checked body loading** — the SKILL.md body is loaded into model context only after capability checks pass (SPEC §35.2).
4. **Hash pinning** — `skill_md_hash` pins the exact SKILL.md body; changes require reauthorization (similar to MCP descriptor pinning, ADR-0018).
5. **Isolated execution** — skill scripts (if any) execute through kernel capabilities, never in-process (ADR-0019).
6. **Trust levels** — `trusted` (built-in or first-party), `untrusted` (third-party). Untrusted skills get reduced capabilities and taint tracking.
7. **Malicious fixture** — `skills/fixtures/malicious/` provides a deliberately malicious skill for prompt-injection testing.

Built-in skills: `skills/builtin/{diff-apply,test-run,search-symbol,verification-plan,release-notes,database-migration-review}/`.

## Alternatives

- **Adopt upstream Agent Skills verbatim.** Rejected: no capability declaration; no hash pinning; no provenance; insufficient for Terminus's security model.
- **Reject Agent Skills; use only Terminus-native format.** Rejected: loses ecosystem compatibility; users cannot reuse existing skills.
- **In-process skill execution.** Rejected (SPEC §49.6): violates non-bypassability; no isolation.

## Consequences

- Skills are first-class capabilities in the Terminus registry (`packages/capability-registry`).
- The `capability` tool (ADR-0012) activates skills per task.
- Skill bodies are loaded progressively (only when relevant), not all at once (SPEC §11.2).
- Untrusted skills are taint-tracked (SPEC §36.15).
- Skill hashes are recorded in the context manifest (ADR-0010) for audit.

## Security Impact

Medium. Hash pinning prevents silent skill replacement. Capability declaration prevents ambient authority. Isolated execution prevents in-process escapes. Taint tracking prevents prompt injection from skill bodies. The malicious fixture (`skills/fixtures/malicious/`) is used by 4 of the 5 security evals.

## Evaluation Plan

- Skill loading tests: upstream format loads; terminus.skill.yaml validates; hash matches.
- Malicious skill tests: prompt-injection payload in SKILL.md is detected and contained.
- Capability enforcement tests: skill without `network` capability cannot make network calls.
- Hash-pinning tests: changed SKILL.md body triggers reauthorization.

## Migration

Skills are introduced in M9 (SPEC §48.12) through the Terminus capability registry. External skill formats are decoded at that first-party boundary.

## Rollback

If a skill proves harmful, quarantine it (disable + export + provenance preserved). If the Agent Skills spec changes incompatibly, fork the loader (keep upstream compatibility for old skills; add a new path for new skills).
