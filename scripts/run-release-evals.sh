#!/usr/bin/env bash
# Release-tier eval evidence (SPEC §46.11 eval-release).
# Always writes an evaluation report, defaulting to
# artifacts/release-gate/eval-release.json — never silent skip.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_JSON="${TERMINUS_RELEASE_EVAL_OUTPUT:-$ROOT/artifacts/release-gate/eval-release.json}"
mkdir -p "$(dirname "$OUT_JSON")"
generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

status="failed"
reason=""
mode=""

PY="${ROOT}/python/forge_evals"
export PYTHONPATH="${PY}${PYTHONPATH:+:$PYTHONPATH}"

# Use the locked evaluation environment rather than the runner's system
# interpreter. The release probe imports PyYAML and other package dependencies
# that are intentionally not installed globally on CI hosts.
run_python() {
  uv run --project "${ROOT}/python" python "$@"
}

if run_python - <<'PY'
import importlib.util
import sys
spec = importlib.util.find_spec("forge_evals.baselines")
sys.exit(0 if spec is not None else 1)
PY
then
  baseline_check_output=""
  baseline_check_status=0
  if baseline_check_output="$(run_python - <<'PY' 2>&1
import sys
from forge_evals.baselines import BASELINES, all_baseline_ids, baseline_by_id

ids = all_baseline_ids()
assert isinstance(ids, list)
assert len(BASELINES) > 0
assert len(ids) == len(BASELINES)
blocked = []
for baseline_id in ids:
    baseline = baseline_by_id(baseline_id)
    if not baseline.live_runner_available:
        blocked.append(f"{baseline_id}: live runner unavailable")
    if not baseline.pin_verified or baseline.pin_kind == "unconfigured":
        blocked.append(f"{baseline_id}: exact pin is not independently verified")
if blocked:
    print("known_unavailable:" + "; ".join(blocked), file=sys.stderr)
    raise SystemExit(2)
print(f"live_baselines={len(ids)}")
PY
)"; then
    status="blocked"
    mode="forge_evals.baselines"
    reason="catalogued live runners are ready, but this probe did not produce a live benchmark report"
  else
    baseline_check_status=$?
    if [[ -n "$baseline_check_output" ]]; then
      printf '%s\n' "$baseline_check_output" >&2
    fi
    if [[ "$baseline_check_status" == "2" && "$baseline_check_output" == known_unavailable:* ]]; then
      mode="forge_evals.baselines"
      if [[ "${TERMINUS_RELEASE_ALLOW_PENDING_LIVE_EVAL:-}" == "1" ]]; then
        status="pending_live_eval"
        reason="live baseline runner or exact pin is unavailable; live release evaluation remains pending"
      else
        status="blocked"
        reason="live baseline runner, exact pin, or independent verification is absent"
      fi
    else
      status="blocked"
      mode="forge_evals.baselines"
      reason="baseline registry validation failed"
    fi
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
  "pass": $([[ "$status" == "passed" ]] && echo true || echo false),
  "generatedAt": "$generated_at",
  "mode": "$mode",
  "reason": "$reason_json"
}
EOF

echo "[eval-release] status=$status → $OUT_JSON"
# Release evaluation must fail closed. Pending live evidence is only a
# CI-local M12 record; it cannot satisfy a stable release gate.
if [[ "$status" != "passed" && "$status" != "pending_live_eval" ]]; then
  exit 1
fi
