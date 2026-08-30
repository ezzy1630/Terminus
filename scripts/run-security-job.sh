#!/usr/bin/env bash
# Run one CI security command and always write its machine-readable outcome.
# Command arguments are deliberately excluded from the artifact because they
# may contain credentials or other sensitive values.
set -euo pipefail

usage() {
  echo "usage: $0 <job> <result.json> <failure-classification> <promotable> -- <command> [args...]" >&2
  exit 64
}

[[ $# -ge 6 ]] || usage

job="$1"
result="$2"
failure_classification="$3"
promotable="$4"
separator="$5"
shift 5

[[ "$job" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || usage
case "$failure_classification" in
  product_failure | dependency_failure | non_promotable_environment) ;;
  *) usage ;;
esac
[[ "$promotable" == "true" || "$promotable" == "false" ]] || usage
[[ "$separator" == "--" && $# -gt 0 ]] || usage

release_version="${TERMINUS_RELEASE_VERSION:-}"
if [[ -n "$release_version" ]]; then
  [[ "$release_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || usage
  release_version_json="\"$release_version\""
else
  release_version_json="null"
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$(dirname "$result")"

set +e
"$@"
exit_code=$?
set -e

if ((exit_code == 0)); then
  status="passed"
  classification="none"
elif [[ "$failure_classification" == "non_promotable_environment" ]]; then
  status="not_run"
  classification="$failure_classification"
else
  status="failed"
  classification="$failure_classification"
fi

candidate_commit="${GITHUB_SHA:-}"
if [[ -z "$candidate_commit" ]]; then
  candidate_commit="$(git -C "$root" rev-parse HEAD 2>/dev/null || true)"
fi
[[ "$candidate_commit" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || candidate_commit="unknown"

generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
runner_os="${RUNNER_OS:-unknown}"
runner_arch="${RUNNER_ARCH:-unknown}"
[[ "$runner_os" =~ ^[A-Za-z0-9_-]+$ ]] || runner_os="unknown"
[[ "$runner_arch" =~ ^[A-Za-z0-9_-]+$ ]] || runner_arch="unknown"
temporary="$(mktemp "${result}.tmp.XXXXXX")"
printf '{\n  "schema_version": 1,\n  "job": "%s",\n  "status": "%s",\n  "classification": "%s",\n  "promotable": %s,\n  "candidate_commit": "%s",\n  "release_version": %s,\n  "runner": {"os": "%s", "arch": "%s"},\n  "exit_code": %d,\n  "generated_at": "%s"\n}\n' \
  "$job" \
  "$status" \
  "$classification" \
  "$promotable" \
  "$candidate_commit" \
  "$release_version_json" \
  "$runner_os" \
  "$runner_arch" \
  "$exit_code" \
  "$generated_at" >"$temporary"
mv "$temporary" "$result"

echo "[security-job] job=$job status=$status classification=$classification result=$result"
exit "$exit_code"
