# Runbook: Orphaned jobs

## When to use

Use this runbook when durable jobs (`JobService`) reference processes that no longer exist, when the control plane restart leaves jobs in an inconsistent state, or when `JobService.Get` returns `unknown` settlement for prolonged periods. Job reconciliation runs on restart (SPEC §29.5, §31.1).

## Symptoms

- `JobService.Get` returns `state: unknown` for a job that should have settled.
- Job streams emit `JobReconciled` with `unknown-settlement` repeatedly.
- Job processes are running on the host but not tracked by the kernel.
- Job artifacts (stdout/stderr) are missing or partial.
- Database has `jobs` rows with `state: running` but no corresponding kernel process.

## Diagnosis

1. List orphaned jobs:
   ```bash
   sqlite3 db/terminus.db "SELECT id, session_id, task_id, state, started_at FROM jobs WHERE state IN ('running', 'unknown') ORDER BY started_at;"
   ```
2. Check if the process is actually running on the host:
   ```bash
   ps aux | grep -F "<program from CommandSpec>"
   ```
3. Check the kernel job table:
   ```bash
   grpcurl -plaintext -unix /var/run/terminus-kernel.sock terminus.kernel.v1.JobService/Get '{"job_id": "<id>"}'
   ```
4. Check job artifacts:
   ```bash
   ls -la <artifact-root>/sha256/.../  # stdout_artifact, stderr_artifact
   ```
5. Check the kernel reconciliation log on last restart.

## Immediate actions

1. **For jobs with `state: running` but no host process:** the process died without settling. Mark as `unknown-settlement` and reconcile:
   - If the job was idempotent (e.g., test run): mark as `failed` and re-run if the task is still active.
   - If the job was non-idempotent (e.g., `git push`): do NOT re-run. Reconcile externally (check if the push landed) before deciding (SPEC §26.3 #9).
2. **For jobs with `state: unknown` for > N minutes:** escalate. The reconciliation loop should have settled by now.
3. **For jobs with missing artifacts:** the process died before producing output. Mark as `failed` with `evidence: missing`.
4. **For host processes running without kernel tracking:** kill them (they're orphans) and mark the corresponding jobs as `failed`.

## Recovery

1. Reconcile each orphaned job:
   ```bash
   # Trigger reconciliation (the kernel does this on startup, but can be triggered manually)
   grpcurl -plaintext -unix /var/run/terminus-kernel.sock terminus.kernel.v1.JobService/Get '{"job_id": "<id>"}'
   # The response includes the reconciled state
   ```
2. For `unknown-settlement` non-idempotent jobs, manually verify the external state (e.g., did the deploy land? did the push succeed?) before marking `success` or `failed`.
3. Update the `jobs` table to reflect the reconciled state.
4. Notify affected sessions/tasks.
5. Run the job reconciliation test suite (SPEC §46.5).

## Post-incident

- File an incident report.
- Add the orphan pattern to the recovery test suite (SPEC §46.9).
- Review the reconciliation loop — why didn't it settle?
- If the kernel crashed mid-job, review journal durability (SPEC §29.5).

## Prevention

- Durable jobs survive control-plane restart (SPEC §31.1, §34.12).
- Job reconciliation runs on startup (SPEC §29.5).
- `JobReconciled` events emitted on restart recovery (SPEC §31.1).
- Process-tree ownership prevents orphans (SPEC §36.5).
- Idempotency keys prevent duplicate effects on retry (SPEC §26.3 #9).
- Unknown-settlement reconciliation before retry (SPEC §26.3 #9).
- Nightly recovery tests inject failures at every durable boundary (SPEC §46.9).

## Related

- `docs/runbooks/stuck-external-effect.md` — non-idempotent external effects with unknown settlement.
- `docs/runbooks/kernel-control-version-mismatch.md` — version mismatch can orphan jobs.
- `docs/runbooks/database-corruption.md` — corruption can lose job records.
- SPEC §31.1 (JobService), §34.12 (job tool), §29.5 (checkpoints and recovery), §46.9 (recovery tests).
