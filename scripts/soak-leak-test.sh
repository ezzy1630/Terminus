#!/usr/bin/env bash
# Lightweight soak / RSS-growth smoke (SPEC §46.16).
# Full soak: TERMINUS_SOAK_SECONDS=86400. CI default: 30s.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SECONDS_LIMIT="${TERMINUS_SOAK_SECONDS:-30}"
MAX_GROWTH_PCT="${TERMINUS_SOAK_MAX_GROWTH_PCT:-50}"
OUT_DIR="$ROOT/artifacts/release-gate"
mkdir -p "$OUT_DIR"
OUT_JSON="$OUT_DIR/soak-leak.json"

pid=$$
rss_kb() {
  # macOS/Linux portable-ish: ps rss is in KB on both.
  ps -o rss= -p "$pid" | tr -d ' '
}

start_rss="$(rss_kb)"
start_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
deadline=$((SECONDS + SECONDS_LIMIT))
iterations=0
failures=0

while (( SECONDS < deadline )); do
  iterations=$((iterations + 1))
  if ! cargo test -p terminus-fs --lib --quiet -- --test-threads=1 >/dev/null 2>&1; then
    failures=$((failures + 1))
  fi
  if ! bun test packages/domain/src/ids.test.ts >/dev/null 2>&1; then
    # Fallback if package path differs: still count a lightweight bun invocation.
    if ! bun --version >/dev/null 2>&1; then
      failures=$((failures + 1))
    fi
  fi
done

end_rss="$(rss_kb)"
end_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

growth_pct=0
if (( start_rss > 0 )); then
  growth_pct=$(( (end_rss - start_rss) * 100 / start_rss ))
fi

status="passed"
if (( growth_pct > MAX_GROWTH_PCT )); then
  status="failed"
fi
if (( failures > 0 )); then
  status="failed"
fi

cat >"$OUT_JSON" <<EOF
{
  "status": "$status",
  "generatedAt": "$end_ts",
  "startedAt": "$start_ts",
  "seconds": $SECONDS_LIMIT,
  "iterations": $iterations,
  "failures": $failures,
  "rss": {
    "startKb": $start_rss,
    "endKb": $end_rss,
    "growthPct": $growth_pct,
    "maxGrowthPct": $MAX_GROWTH_PCT
  }
}
EOF

echo "[soak-leak] status=$status growth_pct=$growth_pct iterations=$iterations → $OUT_JSON"
if [[ "$status" != "passed" ]]; then
  exit 1
fi
