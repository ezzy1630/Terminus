# Runbook: Provider outage or billing anomaly

## When to use

Use this runbook when a model provider (OpenAI, Anthropic, Google, local) is unavailable, returning elevated error rates, or when observed costs spike unexpectedly (billing anomaly). Provider outages are operational; billing anomalies may indicate a security issue (see `docs/runbooks/leaked-credential.md`).

## Symptoms

- Provider API returns 5xx errors, rate limits, or timeouts persistently.
- `provider_health` metric drops below threshold.
- Circuit breaker trips for a provider.
- Fallback to secondary provider is engaging frequently.
- Daily cost exceeds budget by > 50%.
- A single task consumes an unexpectedly large number of tokens.
- Repeated retries for the same provider attempt.

## Diagnosis

1. Check provider health:
   ```bash
   curl http://localhost:3050/health/providers
   ```
2. Check the provider's status page (OpenAI, Anthropic, Google).
3. Check recent provider attempts:
   ```bash
   sqlite3 db/forge.db "SELECT provider, model, status, error_code, COUNT(*) FROM provider_attempts WHERE started_at > datetime('now', '-1 hour') GROUP BY provider, model, status, error_code ORDER BY COUNT(*) DESC;"
   ```
4. Check cost trajectory:
   ```bash
   sqlite3 db/forge.db "SELECT date(started_at) AS day, SUM(model_micros) AS cost FROM provider_attempts WHERE started_at > datetime('now', '-7 days') GROUP BY day ORDER BY day;"
   ```
5. Identify the most expensive tasks:
   ```bash
   sqlite3 db/forge.db "SELECT task_id, SUM(model_micros) AS cost, COUNT(*) AS attempts FROM provider_attempts WHERE started_at > datetime('now', '-24 hours') GROUP BY task_id ORDER BY cost DESC LIMIT 20;"
   ```

## Immediate actions

### For provider outage

1. Verify the outage is provider-side (not Forge): check status page, try a minimal API call directly.
2. The circuit breaker should automatically route to fallback providers (SPEC §38). Verify it's engaging.
3. If all providers are down, pause non-critical tasks. Critical tasks may need to wait.
4. Notify users that provider X is degraded; tasks may take longer or use a fallback model.
5. Do not disable the circuit breaker to force a degraded provider — it will just produce more failures.

### For billing anomaly

1. **If suspected credential theft:** follow `docs/runbooks/leaked-credential.md` immediately. Revoke the credential at the source.
2. **If a task is consuming excessive tokens:** check if it's stuck in a loop (SPEC §37.14). Cancel if needed:
   ```bash
   # Cancel the task via the public API
   curl -X POST http://localhost:3000/v1/tasks/<task_id>/cancel
   ```
3. **If a model is more expensive than expected:** check if the routing profile (ADR-0022) is correct. A misconfigured profile may be routing to a more expensive model.
4. **If costs are legitimate but high:** review the budget policy. Tighten per-task budgets if needed.
5. **Verify cost accounting reconciles** (SPEC §50.7): observed cost matches recorded cost.

## Recovery

### For provider outage

1. Monitor the provider's status page for recovery.
2. As the provider recovers, the circuit breaker will re-engage it automatically.
3. Re-run any tasks that failed during the outage (if they're idempotent or can be safely retried).
4. Verify provider health returns to green.

### For billing anomaly

1. Apply the fix (revoke credential, cancel task, fix routing profile, tighten budgets).
2. Verify costs return to expected levels.
3. Run the cost reconciliation test suite (SPEC §50.7).

## Post-incident

- File an incident report (especially for billing anomalies that suggest credential theft).
- Add the provider's outage signature to the circuit breaker configuration.
- Review the routing profile and fallback chain (ADR-0022).
- For billing anomalies, audit all tasks that ran during the anomaly period.
- Update the provider capability snapshot if the provider changed their API/models (SPEC §38).

## Prevention

- Provider health monitoring with circuit breakers (SPEC §38).
- Fallback to secondary providers (SPEC §38, ADR-0022).
- Hard budgets per task and per session (SPEC §37.16, §50.7).
- Cost accounting reconciliation (SPEC §50.7).
- Loop detection prevents runaway costs (SPEC §37.14).
- Capability snapshots track provider API/model changes (SPEC §38, ADR-0022).
- Provider confidentiality policy blocks disallowed providers (SPEC §36.18).

## Related

- `docs/runbooks/leaked-credential.md` — if billing anomaly suggests credential theft.
- `docs/runbooks/stuck-external-effect.md` — provider outages can cause unknown settlement.
- `docs/runbooks/orphaned-jobs.md` — provider outages can orphan jobs.
- SPEC §15 (model broker), §38 (provider impl), §37.16 (budget control), §50.7 (cost acceptance).
