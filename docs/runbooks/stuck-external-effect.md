# Runbook: Stuck external effect

## When to use

Use this runbook when an external effect (network write, external-state mutation, deploy, `git push`, API call) is in an `unknown` settlement state and cannot be safely retried. SPEC §26.3 #9 forbids blind retry of uncertain effects.

## Symptoms

- Side-effect record has `settlement_state: unknown` for > N minutes.
- Task is blocked waiting for the effect to settle.
- Provider attempts keep retrying but the effect keeps returning `unknown`.
- External system (e.g., GitHub API, deploy target) is unreachable or returning ambiguous responses.

## Diagnosis

1. Identify the side-effect record:
   ```bash
   sqlite3 db/forge.db "SELECT id, task_id, effect_class, resource_identity, settlement_state, attempted_at, last_checked_at FROM side_effects WHERE settlement_state = 'unknown' ORDER BY attempted_at;"
   ```
2. Check the effect class:
   - `NETWORK_WRITE` — HTTP POST/PUT, webhook, API call.
   - `EXTERNAL_STATE_WRITE` — deploy, database migration, infrastructure change.
   - `git push` (via `forge-git`) — push to remote.
3. Check the external system's state:
   ```bash
   # For an HTTP call: re-read (GET) the resource to see if the write landed
   # For a git push: check the remote ref
   git ls-remote <remote> <ref>
   # For a deploy: check the deploy target's current state
   ```
4. Check the kernel's reconciliation log for the effect.

## Immediate actions

1. **Do NOT blindly retry** (SPEC §26.3 #9). Retrying a non-idempotent effect that may have succeeded can cause duplicate charges, duplicate deploys, or data corruption.
2. **Reconcile externally:**
   - For an HTTP call: re-read the resource (GET) to see if the write landed.
   - For a git push: check the remote ref (`git ls-remote`).
   - For a deploy: check the deploy target's current state.
3. **If the effect succeeded:** mark `settlement_state: success` with evidence (the GET response, the remote ref, the deploy target state).
4. **If the effect failed:** mark `settlement_state: failed` with evidence.
5. **If still unknown:** escalate. The user may need to manually verify or accept the uncertainty.
6. **For idempotent effects (with idempotency key):** safe to retry. The external system will deduplicate.

## Recovery

1. Update the side-effect record with the reconciled state and evidence.
2. Notify the affected task — it can now proceed (success → continue; failed → retry or fail the task).
3. For tasks that have been blocked too long, consider cancelling (SPEC §37.17) and re-running with a fresh contract.
4. Run the recovery test suite for unknown-settlement scenarios (SPEC §46.9).

## Post-incident

- File an incident report.
- Add the external system's ambiguous-response pattern to the reconciliation logic.
- If the external system was down, monitor its recovery.
- Review idempotency: if the effect was non-idempotent and the system doesn't support idempotency keys, consider wrapping future calls in a Forge-level idempotency layer.

## Prevention

- Idempotency keys on all mutating public API operations (SPEC §44.7).
- Idempotency records stored in SQLite (`idempotency_records` table).
- Settlement state tracked for every external effect (SPEC §27.3).
- Unknown-settlement reconciliation before retry (SPEC §26.3 #9, §29.5).
- Recovery tests inject failures before/after external effect starts (SPEC §46.9).
- Circuit breakers for unhealthy external systems (SPEC §38).

## Related

- `docs/runbooks/orphaned-jobs.md` — jobs may produce external effects.
- `docs/runbooks/provider-outage.md` — provider-side outages affecting effects.
- `docs/runbooks/leaked-credential.md` — if the effect leaked a credential.
- SPEC §26.3 #9 (no blind retry), §27.3 (effect taxonomy), §29.5 (reconciliation), §46.9 (recovery tests).
