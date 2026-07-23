# External security assessment

Status and process for third-party assessment of Terminus (SPEC §46.10 release
tier, §50.5). Machine-readable residuals live in
[`findings-register.yaml`](./findings-register.yaml).

## Current status (0.1.0 preview)

- Formal external penetration test: **pending engagement** (`FIND-001`, status
  `accepted` for preview only).
- Internal adversarial suites: required per PR and on the dedicated Linux
  runner (`tests/security/`, SPEC §46.10).
- Compensating controls for the accepted residual are listed below and must
  remain green in the release gate.

## Process

1. **Scope.** Kernel non-bypassability, sandbox escape, network proxy bypass,
   secret broker leakage, MCP/plugin isolation, multi-tenant remote surfaces,
   supply-chain (SBOM, signatures), and recovery/fault injection (SPEC §46.9).
2. **Engagement.** Security owner contracts an independent assessor; scope and
   rules of engagement recorded under `docs/security/`.
3. **Intake.** Every finding gets an id in `findings-register.yaml` with
   severity, owner, and status (`open` | `accepted` | `fixed`).
4. **Disposition.** Critical/SEV1 findings block release until `fixed`.
   Residual non-critical items may be `accepted` only with
   `acceptance_rationale` and compensating controls.
5. **Re-test.** Fixes require regression coverage; accepted items revisit each
   milestone.

## Compensating controls (while FIND-001 is accepted)

- Kernel effect boundary non-bypassability tests (`docs/security/non-bypassability-tests.md`).
- Default-deny policy engine and command AST parsing (`terminus-policy`).
- Secure-local-default sandbox profile; degraded profiles must report honestly.
- Short-lived secret capabilities + output redaction (`terminus-secrets`).
- Destination-aware egress proxy; no ambient sockets from model-facing code.
- SBOM generation and signed artifact verification (`scripts/verify-sbom-local.sh`).
- Coordinated disclosure and emergency patch runbooks under `docs/runbooks/`.
- Fault-injection matrix and upgrade/rollback drills under `tests/`.

## Related

- `SECURITY.md` — reporting contact and trust zones.
- `docs/security/findings-register.yaml` — residual register.
- `docs/security/threat-model.md` — threat/control map.
- `docs/quality/release-gates.md` — gate checklist.
