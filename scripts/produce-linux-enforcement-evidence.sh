#!/usr/bin/env bash
# Produce the signed Linux enforcement manifest consumed by the release gate.
# This script deliberately requires the test suite to publish an effective
# enforcement report; it never upgrades host capabilities into claims.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
manifest="${TERMINUS_LINUX_EVIDENCE:?TERMINUS_LINUX_EVIDENCE is required}"
signature="${TERMINUS_LINUX_EVIDENCE_SIGNATURE:?TERMINUS_LINUX_EVIDENCE_SIGNATURE is required}"
certificate="${TERMINUS_LINUX_EVIDENCE_CERTIFICATE:?TERMINUS_LINUX_EVIDENCE_CERTIFICATE is required}"
report="${TERMINUS_ENFORCEMENT_REPORT:?TERMINUS_ENFORCEMENT_REPORT is required}"
test_log="${TERMINUS_LINUX_TEST_LOG:-${manifest}.test.log}"
test_command="${TERMINUS_LINUX_TEST_COMMAND:?TERMINUS_LINUX_TEST_COMMAND is required}"

fail() {
  echo "[linux-evidence] $*" >&2
  exit 1
}

[[ "$(uname -s)" == "Linux" ]] || fail "Linux runner required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v bwrap >/dev/null 2>&1 || fail "bubblewrap is required"
command -v cosign >/dev/null 2>&1 || fail "cosign is required"
[[ -r /sys/fs/cgroup/cgroup.controllers ]] || fail "cgroup v2 controller inventory is unavailable"
[[ -r "$report" ]] || fail "effective enforcement report is missing: $report"

jq -e '
  .status == "enforced" and
  .sandbox.cgroup_mode == "v2" and
  .sandbox.network_mode == "proxy-only" and
  (.sandbox.seccomp_filter_sha256 | type == "string" and length > 0)
' "$report" >/dev/null || fail "effective report does not prove the secure Linux profile"

mkdir -p "$(dirname "$manifest")"
{
  echo "# command: $test_command"
  bash -lc "$test_command"
} >"$test_log" 2>&1

commit="${TERMINUS_RELEASE_COMMIT:-${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD)}}"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-local/terminus}/actions/runs/${GITHUB_RUN_ID:-local}"
identity="${GITHUB_WORKFLOW:-local}:${GITHUB_RUN_ATTEMPT:-1}"
bwrap_version="$(bwrap --version)"
kernel="$(uname -srvmo)"
controllers="$(tr '\n' ' ' </sys/fs/cgroup/cgroup.controllers | sed 's/[[:space:]]*$//')"
test_digest="sha256:$(sha256sum "$test_log" | awk '{print $1}')"
report_digest="sha256:$(sha256sum "$report" | awk '{print $1}')"
filter_digest="$(jq -r '.sandbox.seccomp_filter_sha256' "$report")"

jq -n \
  --arg commit "$commit" \
  --arg kernel "$kernel" \
  --arg bwrap "$bwrap_version" \
  --arg controllers "$controllers" \
  --arg filter "$filter_digest" \
  --arg test_digest "$test_digest" \
  --arg report_digest "$report_digest" \
  --arg command "$test_command" \
  --arg run_url "$run_url" \
  --arg identity "$identity" \
  '{
    schema_version: 1,
    terminus_commit: $commit,
    runner: {os: "linux", kernel: $kernel},
    sandbox: {
      bubblewrap_version: $bwrap,
      seccomp_filter_sha256: $filter,
      cgroup_mode: "v2",
      cgroup_controllers: $controllers,
      network_mode: "proxy-only"
    },
    test_suite_sha256: $test_digest,
    command: $command,
    exit_status: 0,
    tests: [
      {name: "linux-enforcement", status: "passed", artifact_digest: $test_digest},
      {name: "effective-enforcement-report", status: "passed", artifact_digest: $report_digest}
    ],
    artifact_digests: {test_log: $test_digest, enforcement_report: $report_digest},
    generated_at: (now | todateiso8601),
    ci: {run_url: $run_url, identity: $identity}
  }' >"$manifest"

cosign sign-blob --yes "$manifest" \
  --output-signature "$signature" \
  --output-certificate "$certificate"

echo "[linux-evidence] wrote and signed $manifest"
