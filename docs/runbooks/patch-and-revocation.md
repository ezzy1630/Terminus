# Emergency patch and revocation

Runbook for shipping a security patch and revoking compromised capabilities
(SPEC §36, §46.14 supply chain).

## Emergency patch

1. Confirm severity and blast radius; open finding in
   `docs/security/findings-register.yaml` if not already present.
2. Cut a fix branch; prefer the smallest coherent patch.
3. Add a regression test (security suite or targeted unit/property test).
4. Run `just check` and the applicable security/eval suites from
   `docs/quality/release-gates.md`.
5. Tag a patch release; do not silently change public protocol semantics.
6. Publish release notes that name the fixed finding id.

## Capability / token revocation

1. Identify issued capability tokens / secret handles that must die
   (`terminus-authz`, `terminus-secrets`).
2. Revoke at the broker: mark tokens invalid, rotate signing keys if the
   issuer key is suspect.
3. Restart control plane / kernel processes so in-memory handles are dropped.
4. Audit `SecretAuditLog` / authz logs for use after the compromise window.
5. If remote multi-tenant mode is enabled, drain affected sessions and force
   re-auth.

## SBOM regenerate

```bash
./scripts/verify-sbom-local.sh
# produces artifacts/release-gate/sbom-verify.json
# and, when syft is present, artifacts/release-gate/sbom-cargo.spdx.json
```

Commit or attach the SPDX artifact to the release. Re-run dependency advisory
scans (`cargo deny`, `bun audit`) after the patch.

## Cosign re-sign

1. Rebuild release artifacts from the patched commit.
2. Re-generate SBOMs and Linux enforcement evidence if sandbox code changed.
3. Sign with cosign (keyless or release key per current release policy):

```bash
cosign sign-blob --bundle "${ARTIFACT}.cosign.bundle" "${ARTIFACT}"
```

4. Verify before publish:

```bash
cosign verify-blob --bundle "${ARTIFACT}.cosign.bundle" "${ARTIFACT}"
```

5. Update release-gate evidence under `artifacts/release-gate/` and re-run
   `bun run scripts/m12-exit-gate.ts`.

## Related

- `docs/runbooks/vulnerability-disclosure.md`
- `docs/security/findings-register.yaml`
- `docs/quality/release-evidence.md`
- `scripts/verify-sbom-local.sh`
- `scripts/m12-exit-gate.ts`
