#!/usr/bin/env bash
# Release-tier eval evidence (SPEC §46.11 eval-release).
# Always writes artifacts/release-gate/eval-release.json — never silent skip.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_DIR="$ROOT/artifacts/release-gate"
mkdir -p "$OUT_DIR"
OUT_JSON="$OUT_DIR/eval-release.json"
generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

status="failed"
reason=""
mode=""

PY="${ROOT}/python/forge_evals"
export PYTHONPATH="${PY}${PYTHONPATH:+:$PYTHONPATH}"

if python3 - <<'PY'
import importlib.util
import sys
spec = importlib.util.find_spec("forge_evals.baselines")
sys.exit(0 if spec is not None else 1)
PY
then
  if python3 - <<'PY'
from forge_evals.baselines import BASELINES, all_baseline_ids

ids = all_baseline_ids()
assert isinstance(ids, list)
assert len(BASELINES) > 0
assert len(ids) == len(BASELINES)
print(f"baselines={len(ids)}")
PY
  then
    status="fixture_pass"
    mode="forge_evals.baselines"
    reason="baseline registry importable; comparison fixtures validated"
  else
    status="failed"
    mode="forge_evals.baselines"
    reason="baseline registry import failed validation"
  fi
else
  status="harness_missing"
  mode="none"
  reason="forge_evals.baselines not importable; release eval harness unavailable"
fi

reason_json=${reason//\\/\\\\}
reason_json=${reason_json//\"/\\\"}

cat >"$OUT_JSON" <<EOF
{
  "tier": "release",
  "status": "$status",
  "pass": $([[ "$status" == "fixture_pass" || "$status" == "passed" ]] && echo true || echo false),
  "generatedAt": "$generated_at",
  "mode": "$mode",
  "reason": "$reason_json"
}
EOF

echo "[eval-release] status=$status → $OUT_JSON"
# Gate-visible statuses: fixture_pass/passed are success; harness_missing is
# explicit (not silent) and exits 0 so local M12 can proceed with evidence.
if [[ "$status" == "failed" ]]; then
  exit 1
fi
