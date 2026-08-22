#!/usr/bin/env bash
# eval-baseline — produce the signed baseline evaluation evidence artifact
# (roadmap Phase 0 exit gate: "baseline eval results and costs are signed").
#
# Runs the deterministic smoke suite, digests every result file with SHA-256,
# binds them to the exact HEAD commit, and records cost fields when present.
# Signing uses cosign keyless when available; otherwise the manifest records
# signature.status = "unsigned-local" so absence is explicit, never implied.
#
# Output: artifacts/release-gate/eval-baseline.json (+ .sig when cosign runs)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_DIR="$ROOT/artifacts/release-gate"
mkdir -p "$OUT_DIR"
OUT_JSON="$OUT_DIR/eval-baseline.json"

commit="$(git rev-parse HEAD)"
generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "[eval-baseline] running smoke suite (deterministic fixtures)"
just eval-smoke >/tmp/terminus-eval-smoke.log 2>&1 || {
  echo "[eval-baseline] FAIL: just eval-smoke failed; see /tmp/terminus-eval-smoke.log" >&2
  exit 1
}

# NOTE: justfile's eval-smoke runs from python/, so its relative --output-dir
# resolves to python/evals/results/smoke (not forge_evals/evals/...).
RESULTS_DIR="$ROOT/python/evals/results/smoke"
[[ -d "$RESULTS_DIR" ]] || {
  echo "[eval-baseline] FAIL: no results dir at $RESULTS_DIR" >&2
  exit 1
}

digests="{}"
while IFS= read -r f; do
  rel="${f#"$ROOT"/}"
  d="$(shasum -a 256 "$f" | awk '{print $1}')"
  digests="$(printf '%s' "$digests" | jq --arg k "$rel" --arg v "sha256:$d" '. + {($k): $v}')"
done < <(find "$RESULTS_DIR" -type f \( -name '*.json' -o -name '*.jsonl' \) | sort)

if [[ "$(printf '%s' "$digests" | jq 'length')" -eq 0 ]]; then
  echo "[eval-baseline] FAIL: no result JSON files found under $RESULTS_DIR" >&2
  exit 1
fi

if command -v cosign >/dev/null 2>&1; then
  sig_status="cosign-keyless"
else
  sig_status="unsigned-local"
fi

jq -n \
  --arg commit "$commit" \
  --arg generated_at "$generated_at" \
  --arg sig "$sig_status" \
  --argjson digests "$digests" \
  '{tier: "baseline",
    status: "passed",
    harness: "terminus-minimal",
    commit: $commit,
    generatedAt: $generated_at,
    results_sha256: $digests,
    costs: {note: "cost fields recorded per run record when providers report usage; fixture harness reports zero"},
    signature: {status: $sig}}' >"$OUT_JSON"

if command -v cosign >/dev/null 2>&1; then
  cosign sign-blob --yes --bundle "$OUT_JSON.bundle" "$OUT_JSON" >/dev/null
else
  echo "[eval-baseline] NOTE: cosign unavailable; baseline recorded unsigned-local (CI signs with cosign)" >&2
fi

echo "[eval-baseline] wrote $OUT_JSON ($(printf '%s' "$digests" | jq 'length') result files bound to ${commit:0:12})"
