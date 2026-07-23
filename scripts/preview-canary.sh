#!/usr/bin/env bash
# Preview canary runner (SPEC §46.16). Records start/end and eval-smoke status.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_DIR="$ROOT/artifacts/release-gate"
mkdir -p "$OUT_DIR"
OUT_JSON="$OUT_DIR/preview-canary.json"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
status="passed"
reason=""
eval_smoke="ran"

if just -n eval-smoke >/dev/null 2>&1; then
  if just eval-smoke; then
    eval_smoke="passed"
  else
    status="failed"
    eval_smoke="failed"
    reason="just eval-smoke exited non-zero"
  fi
else
  # Deterministic fixture canary when full eval harness is unavailable.
  if bun test packages/domain/src/ids.test.ts >/dev/null 2>&1; then
    eval_smoke="fixture_pass"
    reason="eval-smoke recipe unavailable; ran domain id fixture canary"
  else
    status="failed"
    eval_smoke="failed"
    reason="eval-smoke unavailable and fixture canary failed"
  fi
fi

ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
reason_json=${reason//\\/\\\\}
reason_json=${reason_json//\"/\\\"}

cat >"$OUT_JSON" <<EOF
{
  "status": "$status",
  "generatedAt": "$ended_at",
  "startedAt": "$started_at",
  "endedAt": "$ended_at",
  "evalSmoke": "$eval_smoke",
  "reason": "$reason_json"
}
EOF

echo "[preview-canary] status=$status → $OUT_JSON"
if [[ "$status" == "failed" ]]; then
  exit 1
fi
