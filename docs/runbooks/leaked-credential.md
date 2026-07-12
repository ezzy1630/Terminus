# Runbook: Leaked or revoked credential

## When to use

Use this runbook when a secret (API token, SSH key, database password, cloud credential) is suspected to have leaked (visible in logs, artifacts, model-visible context, or commits), or when a credential has been revoked externally and active Forge sessions still hold capabilities for it. This is a security incident — see also `docs/runbooks/security-incident.md`.

## Symptoms

- Secret broker audit log shows a capability use outside expected scope.
- Redaction log shows a redaction event with high severity (secret pattern detected in tool output).
- Provider attempt manifest contains content matching a secret pattern.
- External notification (GitHub, cloud provider) that a credential was exposed.
- User reports a secret in a commit, log, or artifact.
- Capabilities referencing a revoked credential are still active.

## Diagnosis

1. **Contain immediately** (see Immediate actions below) before diagnosing.
2. Search for the secret in all Forge-managed stores:
   ```bash
   # SQLite (should never contain raw secrets, but verify)
   sqlite3 db/forge.db "SELECT id FROM artifacts WHERE sha256 = '<sha256 of the secret>';"
   # Artifact store
   grep -r "<secret-pattern>" <artifact-root>/  # Use a pattern, not the raw secret
   # Logs
   grep -r "<secret-pattern>" logs/
   # Git history (the secret may have been committed)
   git log -p --all | grep -F "<secret-pattern>"
   ```
3. Check the secret broker audit log:
   ```bash
   sqlite3 db/forge.db "SELECT * FROM secret_audit WHERE capability_uri LIKE '%<provider>%' ORDER BY used_at DESC LIMIT 50;"
   ```
4. Identify which sessions/tasks used the credential.

## Immediate actions

1. **Revoke the credential at the source** (GitHub settings, cloud provider console, etc.). This is the most important step — do it before anything else.
2. **Revoke the Forge-issued capability:**
   ```bash
   # The kernel SecretService supports revocation
   grpcurl -plaintext -unix /var/run/forge-kernel.sock forge.kernel.v1.SecretService/Revoke '{"capability_uri": "secret://<provider>/<id>"}'
   ```
3. **Kill affected processes** (capabilities are short-lived but already-running processes may hold the secret in their environment):
   ```bash
   # Identify and cancel affected jobs
   sqlite3 db/forge.db "SELECT job_id FROM jobs WHERE secret_capability_uris LIKE '%<capability-id>%' AND state = 'running';"
   ```
4. **Quarantine affected artifacts** (move to a quarantine directory; do not delete — they're evidence):
   ```bash
   mkdir -p quarantine/leak-<date>
   mv <affected-artifacts> quarantine/leak-<date>/
   ```
5. **Notify affected users** whose sessions used the credential.
6. **Rotate the credential** at the source (issue a new one; do not re-enable the old one).

## Recovery

1. Issue a new credential at the source.
2. Update the Forge secret broker with the new credential (do not reuse the old capability URI).
3. Restart affected sessions/tasks with the new capability.
4. Verify the old capability is revoked and unusable.
5. Run the secret redaction test suite (`evals/security/secret-extraction.yaml`).

## Post-incident

- File a security incident report (`docs/runbooks/security-incident.md`).
- Trace how the leak occurred:
  - Redaction failure? (Add the pattern to `policies/secrets/default.yaml`.)
  - Capability scope too broad? (Tighten the capability.)
  - User-approved scope expansion? (Review approval policy.)
  - Provider response contained the secret? (File a provider bug; add a redaction pattern.)
- Add the leak signature to the security evals.
- If the secret was committed to Git, force-push to remove it from history (coordinate with anyone who may have pulled).
- Review the secret broker audit log for any other suspicious uses.

## Prevention

- No ambient secrets (`secrets.direct_environment: deny`, SPEC §36.4, ADR-0016).
- Model-invisible (`secrets.model_visibility: deny`, SPEC §26.3 #6).
- Output redaction (`crates/forge-secrets/src/redact.rs`).
- Short-lived capabilities with TTLs (SPEC §13.6).
- Per-task scoping (SPEC §13.6).
- Audit log for every secret use (SPEC §36.13).
- Secret redaction fixtures in per-PR security tests (SPEC §46.10).
- Encoded exfiltration tests (`evals/security/secret-extraction.yaml`).

## Related

- `docs/runbooks/security-incident.md` — full incident response.
- `docs/runbooks/compromised-extension.md` — if the leak came from an extension.
- `docs/architecture/trust-boundaries.md` — secret broker design.
- SPEC §13.6 (secret broker), §36.13 (secret broker impl), §26.3 #6 (no raw model-visible secrets).
