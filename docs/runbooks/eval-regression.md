# Runbook: Evaluation regression

## When to use

Use this runbook when the eval lab detects a regression: a feature, configuration, dependency update, or external-adapter change causes a cohort's success rate, cost, or safety sub-metric to regress beyond the non-regression threshold (SPEC §46.18, §50.9). Eval regressions block releases.

## Symptoms

- `eval-smoke` or `eval-targeted` CI job fails on a PR.
- `eval-nightly` shows a cohort regression beyond the non-regression threshold.
- `eval-release` shows the full baseline comparison failing.
- Promotion gate (SPEC §41.12, §18.7) blocks a feature promotion.
- Safety sub-metric regressed (release blocker, ADR-0001).
- Cost per task increased beyond budget.

## Diagnosis

1. Identify the regressing cohort and metric:
   ```bash
   cd python
   uv run terminus-eval analyze --experiment <id> --compare-to baseline
   ```
2. Check the regression detector output:
   ```bash
   cd python
   uv run terminus-eval analyze --experiment <id> --regression-detector
   ```
3. Identify the change that caused the regression:
   - Which PR merged before the regression?
   - Which feature flag was toggled?
   - Which dependency or external-adapter update occurred?
   - Which provider/model snapshot changed?
4. Run the affected cohort with the change reverted (if possible) to confirm causation:
   ```bash
   cd python
   uv run terminus-eval run --suite <suite> --task <task-id> --task-dir <task-package> --harness <harness-id> --seeds 3
   ```

## Immediate actions

1. **If the regression is on a safety sub-metric:** this is a release blocker. Revert the change immediately. Do not merge until the safety sub-metric recovers (ADR-0001).
2. **If the regression is on the primary metric (verified success/cost):**
   - For a feature PR: do not merge. Either fix the regression or do not promote the feature (ADR-0025).
   - For a dependency or external-adapter update: consider reverting it or fixing the regression before retrying.
   - For a provider/model snapshot change: revert to the previous snapshot if possible; otherwise investigate.
3. **If the regression is on a non-target cohort:** the feature may still be promotable if it improves its target cohort and the non-target regression is within the "unacceptable" threshold (ADR-0025, Appendix I.2). Document the trade-off.
4. **If the regression is on cost only:** tighten budgets or optimize the feature. Cost regression without quality regression is not necessarily a blocker, but it reduces the primary metric.

## Recovery

1. Revert the causing change (if identified and reversible).
2. Re-run the affected cohort to verify recovery:
   ```bash
   cd python
   uv run terminus-eval run --suite <suite> --task <task-id> --task-dir <task-package> --harness <harness-id> --seeds 3
   ```
3. If the change is not reversible, fix the regression with a follow-up PR.
4. Update the non-regression thresholds if the regression is intentional and accepted (requires ADR amendment).
5. Run the full eval suite to verify no other cohorts regressed.

## Post-incident

- File an incident report (especially for safety regressions).
- Add the regression signature to the regression detector (`python/forge_evals/forge_evals/analysis/regression_detector.py`).
- Add a conformance test if the regression was caused by an external-adapter update.
- Review the non-regression thresholds — are they appropriate?
- If the regression was caused by a feature, decide: fix, demote (EXPERIMENTAL/REJECTED), or accept with documented trade-off (ADR-0025).
- Archive the evidence (URL, retrieval date, content hash, interpretation note per Appendix J.4).

## Prevention

- `eval-smoke` runs on every PR with the `agent-behavior` label (SPEC §46.11).
- `eval-targeted` runs on the changed component's cohort (SPEC §46.11).
- `eval-nightly` runs the broad pinned suite (SPEC §46.11).
- `eval-release` runs the full promotion suite (SPEC §46.11, §46.18).
- Promotion gate (SPEC §41.12, §18.7, ADR-0025) governs feature promotion.
- Non-regression thresholds enforced at release gate (SPEC §46.18, §50.9).
- Safety sub-metrics are release blockers (ADR-0001).
- Permanent minimal baseline (ADR-0025) provides a control arm.
- Random seeds and pinned environments ensure reproducibility (SPEC §41.4, §44.4).

## Related

- `docs/architecture/overview.md` — client, control, adapter, and kernel boundaries.
- `docs/runbooks/provider-outage.md` — if the regression was caused by a provider change.
- `docs/runbooks/security-incident.md` — if the regression is a safety regression.
- `docs/quality/release-gates.md` — release gate criteria.
- SPEC §18 (eval lab), §41 (impl), §46.11 (eval tiers), §46.18 (release gate), §50.9 (quality/release acceptance).
- `docs/architecture/evaluation-lab.md` — causal baseline-vs-candidate system (ADR-0056), tier commands, report schemas.
- `docs/decisions/ADR-0056-causal-baseline-candidate-evaluation-tiers.md` — the three-tier decision and gate semantics.
