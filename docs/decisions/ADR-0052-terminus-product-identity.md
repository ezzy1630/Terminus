# ADR-0052: Terminus product identity and compatibility window

- **Status:** ADOPTED
- **Date:** 2026-08-27
- **Decision owner:** product architecture
- **Supersedes:** Forge as the visible product name
- **Related:** SPEC §1, §30, §43; ADR-0017; ADR-0026; ADR-0039

## Context

The repository adopted Terminus as its product name while several normative,
client, configuration, and evaluation surfaces still exposed the former Forge
name. A blind repository-wide rename would break stored identifiers, signed
capability manifests, Python imports, configuration files, and external clients.

## Decision

Terminus is the canonical visible product name and the prefix for new public
symbols, environment variables, commands, runtime paths, and harness IDs.

The following compatibility names remain accepted for one deprecation window:

| Canonical name | Compatibility name | Migration behavior |
| --- | --- | --- |
| `TerminusClient` | `ForgeClient` | Deprecated TypeScript export alias |
| `TerminusError` | `ForgeError` | Deprecated TypeScript export alias |
| `TERMINUS_ROOT` | `FORGE_ROOT` | Canonical variable wins when both are set |
| `terminus-minimal`, `terminus-full` | `forge_minimal`, `forge_full` | Old harness IDs resolve to canonical profiles |
| `terminus.skill.yaml` | `forge.skill.yaml` | Old manifest filename remains readable |
| `python/forge_evals` and `forge_evals` | future package migration | Historical import container remains stable |

Persisted IDs, signed capability IDs, schema URLs, and historical release or
legal text are not rewritten in place. They are migrated only by an explicit,
versioned reader/writer or schema migration. New output MUST use Terminus names.

## Consequences

- User-visible surfaces and normative prose say Terminus.
- Compatibility names are explicit and testable instead of accidental.
- Tooling may reject newly introduced visible Forge branding while allowing the
  bounded compatibility and historical surfaces above.
- Removing a compatibility alias requires a separate ADR and migration evidence.
