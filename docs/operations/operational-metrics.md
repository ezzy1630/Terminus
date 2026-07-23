# Operational metrics (canary)

Which metrics are collected during preview/canary soaks, and where JSON
evidence lands for the release gate (SPEC §26.6, §46.16).

## When

- Preview canary: `scripts/preview-canary.sh`
- Soak / RSS smoke: `scripts/soak-leak-test.sh`
- Placeholder counter snapshot: `scripts/collect-ops-metrics.ts`

## Categories

Aligned with `docs/product/metrics.md`:

| Category | Examples |
|---|---|
| **Runtime** | total latency, time to first useful action, context compilation overhead, tool overhead, restart/resume success |
| **Agent quality** | final success, first-patch success, acceptance coverage, regression rate, changed-line/file excess, user corrections/approvals, token breakdown |
| **Security** | unsafe attempts, policy denials, sandbox escapes, stale-context/stale-write incidents, plugin descriptor changes |

Safety sub-metrics MUST remain separate — no single aggregate may conceal a
security regression (SPEC §26.6).

## Artifact paths

All canary/release JSON evidence is written under:

```text
artifacts/release-gate/
  ops-metrics.json       # collect-ops-metrics.ts
  preview-canary.json    # preview-canary.sh
  soak-leak.json         # soak-leak-test.sh
  eval-release.json      # run-release-evals.sh
  exit-gate-report.json  # m12-exit-gate.ts aggregate
```

`ops-metrics.json` may be a **placeholder** counter structure during early M12
while live exporters are wired; the schema (runtime / agentQuality / security)
is stable for dashboards.

## Related

- `docs/product/metrics.md` — normative metric definitions.
- `docs/quality/release-evidence.md` — how evidence is verified.
- `docs/quality/release-gates.md` — gate checklist.
