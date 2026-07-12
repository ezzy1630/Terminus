# Runbook: Security incident and trace export

## When to use

Use this runbook for any security incident: sandbox escape, secret leakage, prompt injection causing unauthorized effects, compromised extension, supply-chain attack, multi-tenant boundary violation, or any event that violated (or attempted to violate) a non-negotiable invariant (SPEC §26.3).

This runbook coordinates with the more specific runbooks (`leaked-credential.md`, `compromised-extension.md`, `sandbox-unavailable.md`, etc.).

## Severity classification

| Severity | Examples | Response time |
|---|---|---|
| **SEV1** | Confirmed sandbox escape; multi-tenant data access; RCE via model output | Immediate, 24/7 |
| **SEV2** | Secret leaked to model or external system; prompt injection caused unauthorized effect | Immediate (business hours) |
| **SEV3** | Extension escape attempt blocked; bypass register entry not contained | Same day |
| **SEV4** | Near-miss; security eval caught a regression before release | Next sprint |

## Immediate actions (SEV1/SEV2)

1. **Contain:**
   - Stop affected Forge processes (`just run` is not running).
   - Revoke compromised capabilities (see `docs/runbooks/leaked-credential.md`, `docs/runbooks/compromised-extension.md`).
   - Kill affected jobs/processes.
   - Quarantine affected artifacts (do not delete — they're evidence).
2. **Notify:**
   - Security owner (required reviewer per SPEC §44.8).
   - Release owner (if release is affected).
   - Affected users (whose sessions/tasks are affected).
3. **Preserve evidence:**
   - Snapshot the SQLite database.
   - Snapshot the artifact directory.
   - Snapshot the logs.
   - Export the OpenTelemetry trace for affected tasks.
   - Do not delete anything.

## Diagnosis

1. Identify which invariant was violated (SPEC §26.3):
   - #1 No ambient effects — direct effect bypass?
   - #2 No hidden model input — manifest missing or incomplete?
   - #3 No completion by assertion — completion without evidence?
   - #4 No silent truncation — truncation not reported?
   - #5 No stale write — write without baseline?
   - #6 No raw model-visible secrets — secret in manifest?
   - #7 No destructive compaction — raw evidence lost?
   - #8 No implicit extension authority — extension exceeded scope?
   - #9 No blind retry of uncertain effects — duplicate external write?
   - #10 No unpinned experiment as a default — feature without evaluation?
   - #11 No unreported degradation — degraded sandbox not reported?
   - #12 No uncontrolled upstream divergence — divergence budget exceeded?
2. Trace the attack path:
   - Which model output, repository file, web content, or extension initiated the attack?
   - Which taint sources propagated?
   - Which policy decision allowed the effect?
   - Which capability was used?
3. Identify the root cause:
   - Sandbox bug?
   - Policy gap?
   - Redaction failure?
   - Descriptor pinning bypassed?
   - Architecture-boundary check missing?

## Trace export

Export the full trace for forensic analysis:

```bash
# Export the OpenTelemetry trace for the affected task
curl http://localhost:3050/admin/trace/<task_id> > trace-<task_id>.json

# Export the context manifest for each provider attempt in the affected turn
sqlite3 db/forge.db "SELECT id FROM context_manifests WHERE task_id = '<task_id>' ORDER BY persisted_at;" > manifest-ids.txt
# For each manifest ID, export the full manifest and its fragments

# Export the artifact directory listing
find <artifact-root> -type f > artifacts-listing.txt

# Export the audit log for the affected period
sqlite3 db/forge.db "SELECT * FROM secret_audit WHERE used_at > datetime('now', '-24 hours');" > secret-audit.csv
sqlite3 db/forge.db "SELECT * FROM capability_audit WHERE occurred_at > datetime('now', '-24 hours');" > capability-audit.csv
sqlite3 db/forge.db "SELECT * FROM policy_decisions WHERE decided_at > datetime('now', '-24 hours');" > policy-decisions.csv

# Export the bypass register
cp docs/security/effect-bypass-register.yaml bypass-register-<date>.yaml
```

## Recovery

1. Apply the fix (sandbox patch, policy update, redaction pattern, descriptor re-pinning, architecture-boundary check addition).
2. Run the full security suite (`just security` + nightly suite, SPEC §46.10).
3. Run the affected security evals (`evals/security/*.yaml`).
4. Run the non-bypassability tests (`docs/security/non-bypassability-tests.md`).
5. Verify the invariant is restored.
6. Restart Forge processes.
7. Notify affected users that the incident is resolved.

## Post-incident

1. **Post-mortem** (within 5 business days for SEV1/SEV2):
   - Timeline of the incident.
   - Invariant violated.
   - Attack path.
   - Root cause.
   - What contained it (or didn't).
   - What failed in detection.
   - Action items with owners and dates.
2. **Update tests:** add the attack signature to the security evals and the non-bypassability tests.
3. **Update runbooks:** if the runbook was insufficient, update it.
4. **Update the bypass register:** if a new bypass was discovered, add it to `docs/security/effect-bypass-register.yaml`.
5. **Update ADRs:** if the root cause was an architectural gap, amend or add an ADR.
6. **Disclosure:** if user data was affected, disclose per the project's disclosure policy (see `SECURITY.md`).
7. **Sign-off:** security owner, release owner, and (for SEV1) protocol owner sign off on the post-mortem and action items.

## Prevention

- Non-bypassability tests run continuously (SPEC §27.4).
- Security evals run per-PR, nightly, and at release (SPEC §46.10).
- Bypass register tracks inherited effect paths (SPEC §27.5).
- Architecture-boundary checks run in CI (SPEC §42.5).
- Supply-chain scans and SBOM per release (SPEC §46.14, §36.17).
- Descriptor pinning and reauthorization (SPEC §35.3, ADR-0018).
- Taint tracking on all untrusted content (SPEC §36.15).
- Audit logs for all privileged effects (SPEC §27.3, §36.3).
- Incident drills run periodically (SPEC §48.15 task 12).

## Related

- `docs/runbooks/leaked-credential.md`
- `docs/runbooks/compromised-extension.md`
- `docs/runbooks/sandbox-unavailable.md`
- `docs/architecture/trust-boundaries.md`
- `docs/security/threat-model.md`
- `docs/security/effect-bypass-register.yaml`
- `docs/security/non-bypassability-tests.md`
- `SECURITY.md`
- SPEC §5.2 (non-bypassability), §26.3 (invariants), §27 (trust model), §36 (security impl), §46.10 (security tests).
