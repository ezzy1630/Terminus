# Product success metrics

This document specifies the Terminus product success metrics dashboard (SPEC §1, §26.6, ADR-0001). The primary metric is verified successful tasks per dollar-hour; the dashboard MUST include the full breakdown so no single aggregate score can conceal a safety regression.

## Primary metric (ADR-0001)

```
verified_successful_tasks
──────────────────────────────────────────────────────────────
model_cost + compute_cost + elapsed_time_cost + human_attention
```

The denominator MUST be reported as separate components as well as any composite:

- `model_cost` — total model cost (integer micros of the configured billing currency).
- `compute_cost` — total compute cost (CPU seconds × cost-per-second).
- `elapsed_time_cost` — wall-clock seconds × cost-per-second (the user's time has value).
- `human_attention` — human approval count × cost-per-approval (or actual time spent reviewing).

## Dashboard (SPEC §26.6)

The product dashboard MUST include:

### Success metrics

- **Final success** — task completed with all required verification predicates passing.
- **First-patch success** — task completed on the first model-generated patch.
- **Acceptance-criterion coverage** — fraction of acceptance criteria satisfied by evidence.
- **Regression rate** — fraction of previously-passing tasks that now fail.

### Quality metrics

- **Changed-line excess** — `(changed_lines - expected_lines) / expected_lines`.
- **Changed-file excess** — `(changed_files - expected_files) / expected_files`.
- **User corrections** — count of user corrections after a task was marked complete.
- **User approvals** — count of user approvals during the task.

### Token metrics

- **Input tokens** — total input tokens (per provider).
- **Output tokens** — total output tokens (per provider).
- **Cached tokens** — total cached tokens (cache hits).
- **Reasoning tokens** — total reasoning tokens (where applicable).
- **Tool-schema tokens** — total tokens consumed by tool schemas.

### Overhead metrics

- **Context compilation overhead** — time spent in the Context Compiler (ADR-0009).
- **Tool overhead** — time spent in tool execution (excluding the tool's own work).

### Latency metrics

- **Total latency** — wall-clock from task start to completion.
- **Time to first useful action** — wall-clock from task start to first tool call or file change.

### Reliability metrics

- **Restart success** — fraction of tasks that resumed successfully after a control-plane restart.
- **Resume success** — fraction of tasks that resumed successfully after a client disconnect.

### Security metrics (release blockers if they regress)

- **Unsafe attempts** — count of effects that were denied by policy.
- **Policy denials** — count of policy `deny` decisions.
- **Sandbox escapes** — count of sandbox escape attempts (should be 0; any non-zero is SEV1).
- **Stale-context incidents** — count of turns where stale world state was detected.
- **Stale-write incidents** — count of writes rejected for stale baseline.

### Extension metrics

- **Plugin/MCP descriptor changes** — count of descriptor changes (rug-pull attempts).

### Upstream metrics

- **Upstream divergence** — modified-file count and merge-conflict hours vs. budget (ADR-0002).

### Feature metrics

- **Feature-specific contribution** — for each feature (context checkpointing, AST retrieval, repo map, tool palette, edit dialect, scout, parallel writers, reviewer, memory, compression, learned router, programmatic tool mode), the contribution to the primary metric via ablation or replay (Appendix I.2).

## Reporting rules (SPEC §26.6)

- No single aggregate score may conceal a safety regression.
- Safety sub-metrics (unsafe attempts, policy denials, sandbox escapes, stale-context, stale-write) are reported separately.
- Cost components are reported separately as well as any composite.
- Feature contributions are reported via ablation (feature on vs. off) or replay (same task, different config).

## Per-task record

Every task produces a record with:

```yaml
task_id:
session_id:
mode:
status:
final_success: bool
first_patch_success: bool
acceptance_criteria_satisfied: [criterion_id]
regression: bool
changed_lines:
changed_files:
expected_changed_lines:
expected_changed_files:
user_corrections: int
user_approvals: int
tokens: { input, output, cached, reasoning, tool_schema }
context_compilation_ms:
tool_overhead_ms:
total_latency_s:
time_to_first_useful_action_s:
restart_success: bool
resume_success: bool
unsafe_attempts: int
policy_denials: int
sandbox_escapes: int
stale_context_incidents: int
stale_write_incidents: int
plugin_descriptor_changes: int
cost: { model_micros, compute_seconds, wall_clock_seconds, human_approvals }
features_active: [feature_id]
repair:
  first_proposal_verified_success: bool | null
  repair_success: bool | null
  attempt_count: int
  repeated_failure: bool
  repeated_failure_count: int
  false_positive_completion: bool | null
  outcome_class: string
  stop_reason: string | null
  classification_correct: bool | null
  additional_input_tokens: decimal_string | null
  additional_output_tokens: decimal_string | null
  additional_cost_micros: decimal_string | null
  additional_duration_ms: int | null
```

The control-plane task snapshot exposes the repair block as a derived,
replayable record from durable repair attempts, verification results, turns,
and provider-attempt usage. Missing provider usage or trusted cost remains
`null`; a stored zero-cost sentinel is not treated as measured spend.

The release-gate collector can aggregate the same records when it receives a
current control-plane database through `TERMINUS_OPS_METRICS_DB` or
`DATABASE_URL`. It emits exact decimal token/cost totals, outcome counts,
duration totals, and missing-measurement counts under the `repair` block.
Without a database, the block is an explicit empty placeholder.

## Aggregation

- Per-task records are aggregated per cohort, per session, per workspace, per provider, per model.
- Aggregations include mean, median, p90, p99, and confidence intervals (bootstrap, SPEC §41.6).
- Aggregations are exported as Parquet for the eval lab.

## Evaluation tiers (SPEC §46.11)

- `eval-smoke` — per-PR for agent-behavior changes.
- `eval-targeted` — changed component's cohort.
- `eval-nightly` — broad pinned suite.
- `eval-release` — full promotion suite and baseline comparison.
- `eval-research` — exploratory and non-gating.

## Related

- `docs/decisions/ADR-0001-verified-successful-tasks-per-dollar-hour.md` — the founding decision.
- `docs/architecture/evaluation-lab.md` — eval lab deep dive.
- `docs/quality/release-gates.md` — release gate criteria.
- SPEC §1, §26.6, §47.3 (metrics), §50 (acceptance).
