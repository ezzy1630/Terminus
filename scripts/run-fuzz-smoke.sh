#!/usr/bin/env bash
# Property / fuzz-smoke suite for release gate (SPEC §46.4 / §46.10).
# Does not run long libfuzzer campaigns — see fuzz/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_DIR="$ROOT/artifacts/release-gate"
mkdir -p "$OUT_DIR"
OUT_JSON="$OUT_DIR/fuzz-smoke.json"
PROP_JSON="$OUT_DIR/property-tests.json"

status="passed"
failures=0
results=()

run_cargo() {
  local crate="$1"
  if cargo test -p "$crate" --tests --quiet; then
    results+=("{\"crate\":\"$crate\",\"status\":\"passed\"}")
  else
    failures=$((failures + 1))
    results+=("{\"crate\":\"$crate\",\"status\":\"failed\"}")
  fi
}

run_cargo terminus-fs
run_cargo terminus-policy
run_cargo terminus-patch
run_cargo terminus-secrets

bun_status="passed"
bun_args=()
if [[ -f packages/domain/src/state_machine_properties.test.ts ]]; then
  bun_args+=("packages/domain/src/state_machine_properties.test.ts")
fi
if [[ -f packages/context-compiler/src/property-tests.test.ts ]]; then
  bun_args+=("packages/context-compiler/src/property-tests.test.ts")
fi
if [[ -f packages/context-ir/src/manifest_properties.test.ts ]]; then
  bun_args+=("packages/context-ir/src/manifest_properties.test.ts")
fi
if [[ -f packages/artifact-client/src/property.test.ts ]]; then
  bun_args+=("packages/artifact-client/src/property.test.ts")
fi
if [[ -f packages/orchestration/src/graph_properties.test.ts ]]; then
  bun_args+=("packages/orchestration/src/graph_properties.test.ts")
fi
if [[ -f packages/capability-registry/src/mcp_schema_fuzz.test.ts ]]; then
  bun_args+=("packages/capability-registry/src/mcp_schema_fuzz.test.ts")
fi
if [[ -f packages/provider-core/src/provider_projection_fuzz.test.ts ]]; then
  bun_args+=("packages/provider-core/src/provider_projection_fuzz.test.ts")
fi

if ((${#bun_args[@]} > 0)); then
  if ! bun test "${bun_args[@]}"; then
    bun_status="failed"
    failures=$((failures + 1))
  fi
else
  bun_status="fixture_missing"
fi

if (( failures > 0 )); then
  status="failed"
fi

generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
crates_json=$(IFS=,; echo "${results[*]}")

cat >"$OUT_JSON" <<EOF
{
  "status": "$status",
  "generatedAt": "$generated_at",
  "crates": [$crates_json],
  "bunPropertyTests": "$bun_status",
  "failures": $failures
}
EOF

cat >"$PROP_JSON" <<EOF
{
  "status": "$status",
  "generatedAt": "$generated_at",
  "source": "run-fuzz-smoke.sh",
  "crates": [$crates_json],
  "bunPropertyTests": "$bun_status"
}
EOF

echo "[fuzz-smoke] status=$status → $OUT_JSON"
if [[ "$status" != "passed" ]]; then
  exit 1
fi
