# ADR-0016: Capability-based secret broker

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** security runtime
- **Supersedes:** none
- **Related:** SPEC §13.6, §36.13

## Context

If secrets are passed via environment variables or files visible to the sandbox, the model can read them (violating SPEC §26.3 #6: "No raw model-visible secrets"). If secrets are passed in tool arguments or prompts, they leak into manifests and logs. Ambient secret access also prevents per-task scoping and revocation.

OpenCode's upstream uses environment-based secrets. Claude Code's hooks and permission modes are useful but do not enforce model-invisibility. We need short-lived, scoped, brokered capabilities that the model sees only as opaque handles.

## Decision

Adopt a **capability-based secret broker** per SPEC §13.6 and §36.13:

1. **No ambient secrets** — `secrets.direct_environment: deny` in the default policy (SPEC §36.4). No secret values in env vars, files visible to the sandbox, or prompts/tool arguments.
2. **Brokered capabilities** — secrets are issued as short-lived capability URIs (e.g., `secret://github/token/<capability-id>`) by the secret broker (`crates/forge-secrets`). The model sees only the URI; the broker injects the actual value into the child process environment at `exec` time.
3. **Per-task scoping** — capabilities are scoped to a task/session and revoked when the task ends. The broker tracks issuance, use, and revocation.
4. **Model-invisible** — `secrets.model_visibility: deny`. The model receives capability handles and redacted metadata, never secret values (SPEC §26.3 #6).
5. **Output redaction** — tool output is scanned for secret patterns and redacted before being shown to the model or persisted (SPEC §36.13, `crates/forge-secrets/src/redact.rs`).
6. **Audit** — every secret use is audited: capability URI, task, tool, timestamp, redaction events.
7. **Provider scopes** — `policies/secrets/default.yaml` declares brokered capabilities for github, gitlab, database, aws, and other providers with TTLs and redaction patterns.

Implementation: `crates/forge-secrets` (broker, redact, audit). Default secrets policy: `policies/secrets/default.yaml`.

## Alternatives

- **Environment variables.** Rejected (SPEC §49.6): model can read; ambient; cannot scope or revoke.
- **Files in the sandbox.** Rejected: same as env vars; model can read.
- **Secrets in prompts/tool arguments.** Rejected (SPEC §49.6): leak into manifests/logs.
- **Vault-only (no broker).** Rejected: cannot inject into child processes without ambient access; loses per-task scoping.

## Consequences

- The model never sees secret values; it sees capability URIs.
- The broker injects secrets into child process environment at `exec` time, after the model has issued the command.
- Output redaction prevents secrets from leaking back through tool results.
- Capabilities are short-lived (TTL) and revoked at task end.
- The audit log is the source of truth for secret use.

## Security Impact

Critical. This is what enforces "No raw model-visible secrets" (SPEC §26.3 #6). The non-bypassability tests (SPEC §27.4) include environment-variable secret access attempts. The security evals (`evals/security/secret-extraction.yaml`) test encoded exfiltration.

## Evaluation Plan

- Secret redaction fixtures (per-PR, SPEC §46.10).
- Encoded exfiltration tests: model attempts to encode secret in output; redaction catches it.
- Capability revocation tests: revoked capability cannot be used.
- Audit completeness tests: every secret use appears in the audit log.

## Migration

The secret broker is introduced in M4 (SPEC §48.7). OpenCode's environment-based secrets are routed through the broker (ADR-0002, `docs/security/effect-bypass-register.yaml`).

## Rollback

If a legitimate use case requires ambient secrets (e.g., a legacy tool that reads from env), grant a narrowly-scoped exception via a named degraded profile (SPEC §13.4) — do not disable the broker globally. If redaction proves too aggressive (false positives), tune the patterns (do not disable redaction).
