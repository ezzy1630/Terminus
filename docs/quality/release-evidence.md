# Release evidence

How M12 release evidence is produced and verified. Maps to
`docs/quality/release-gates.md` (SPEC §46.14–§46.18, §50).

## Produce

| Evidence | Producer | Output |
|---|---|---|
| Fuzz / property smoke | `scripts/run-fuzz-smoke.sh` | `fuzz-smoke.json`, `property-tests.json` |
| Fault injection (§46.9) | `scripts/run-fault-injection.ts` | `fault-injection.json` |
| Upgrade / rollback | `bun test tests/release/upgrade_rollback_drill.test.ts` | `upgrade-rollback.json` |
| Backup / restore | `bun test tests/release/backup_restore_drill.test.ts` | (test-only; covered by upgrade drill evidence) |
| Clean install / downgrade | `bun test tests/release/clean_install_upgrade_downgrade.test.ts` | (test-only) |
| Soak / RSS | `scripts/soak-leak-test.sh` | `soak-leak.json` |
| Preview canary | `scripts/preview-canary.sh` | `preview-canary.json` |
| Ops metrics | `scripts/collect-ops-metrics.ts` | `ops-metrics.json` |
| Eval release | `scripts/run-release-evals.sh` | `eval-release.json` |
| SBOM | `scripts/verify-sbom-local.sh` | `sbom-verify.json` |
| Schema freeze | `scripts/write-schema-freeze-evidence.ts` | `schema-freeze.json` |
| Findings status | `scripts/m12-exit-gate.ts` | `findings-register-status.json` |
| Release decision (§50.10) | `scripts/produce-release-decision.ts` | `release-decision.yaml` |
| Exit gate aggregate | `scripts/m12-exit-gate.ts` | `exit-gate-report.json`, `exit-gate-checklist.md` |

All paths are under `artifacts/release-gate/` unless noted.

LibFuzzer campaigns live in `fuzz/`; CI/release uses `fuzz-smoke` rather than
long campaigns (see `fuzz/README.md`).

## Verify

```bash
bun run scripts/m12-exit-gate.ts
```

The exit gate fails if any required local evidence file is missing or invalid
JSON/YAML. Linux enforcement evidence is `verified` when
`TERMINUS_LINUX_EVIDENCE` is set; otherwise status is `requires_ci` (not a
silent skip).

## Map to release-gates.md

| Gate item | Evidence |
|---|---|
| Platform checks / Linux sandbox | `TERMINUS_LINUX_EVIDENCE` + linux check in exit gate |
| No unresolved critical findings | `findings-register-status.json` + `docs/security/findings-register.yaml` |
| Migration and recovery (§46.9, §50.2) | `fault-injection.json`, `upgrade-rollback.json`, release drills |
| Default policy/eval non-regression | `eval-release.json`, `fuzz-smoke.json` |
| Schemas published / frozen | `schema-freeze.json` ← `schemas/STABLE_VERSIONS.yaml` |
| Canary / soak (§46.16) | `preview-canary.json`, `soak-leak.json`, `ops-metrics.json` |
| Signed artifacts / SBOM (§46.14–15) | `sbom-verify.json` |
| Final acceptance (§50.10) | `release-decision.yaml` |

## Related

- `docs/quality/release-gates.md`
- `docs/operations/operational-metrics.md`
- `docs/security/findings-register.yaml`
- `fuzz/README.md`
