# AGENTS.md — terminus-jobs

## Local rules

- **State machine is sacred.** All transitions go through
  `JobState::transition`. Direct field mutation outside the manager is
  forbidden.
- **Reconcile after restart.** `reconcile(job_id)` MUST mark a job `LOST`
  when its process is gone — silently continuing risks duplicating external
  effects (SPEC.md Section 29.5).
- **Durable records.** `JobRecord` MUST be `Serialize + Deserialize` and
  round-trip through SQLite in production. Never add a non-serializable
  field.
- **No `unsafe`.** No panics. Mutex poisoning is recovered via `into_inner()`.
- **Reuses ProcessManager.** Do not spawn processes directly; route every
  spawn through `ProcessManager` so cancellation, timeouts, and process-tree
  kill are uniform.
