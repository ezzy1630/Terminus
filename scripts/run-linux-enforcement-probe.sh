#!/usr/bin/env bash
# Execute the kernel-owned adversarial sandbox probe and retain its JSON
# report. This script is intentionally Linux-only and is the only producer
# accepted by the signed evidence workflow.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
report="${TERMINUS_ENFORCEMENT_REPORT:?TERMINUS_ENFORCEMENT_REPORT is required}"
binary="${TERMINUS_KERNEL_BINARY:-$ROOT/mini-services/terminus-kernel/target/release/terminus-kernel-mini}"

[[ "$(uname -s)" == "Linux" ]] || { echo "[linux-probe] Linux runner required" >&2; exit 1; }
[[ -x "$binary" ]] || { echo "[linux-probe] kernel binary is not executable: $binary" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "[linux-probe] jq is required" >&2; exit 1; }

mkdir -p "$(dirname "$report")"
"$binary" --terminus-sandbox-probe | tee "$report"

jq -e '
  .status == "enforced" and
  .sandbox.cgroup_mode == "v2" and
  .sandbox.network_mode == "deny" and
  (.sandbox.seccomp_filter_sha256 | type == "string" and length > 0) and
  .checks.seccomp == "blocked" and
  .checks.network == "blocked" and
  .checks.filesystem == "readonly" and
  .checks.cgroup == "visible" and
  .checks.user_namespace == "blocked" and
  .checks.pid_namespace == "blocked" and
  .checks.mount_namespace == "blocked" and
  .checks.network_namespace == "blocked" and
  .checks.protected_git == "blocked" and
  .checks.process_tree == "blocked" and
  .checks.secret_isolation == "blocked" and
  .checks.no_new_privs == "blocked" and
  .exit_status == 0
' "$report" >/dev/null

# Release jobs pass the candidate identity through the probe so the signed
# evidence producer can bind both the enforcement report and its envelope to
# the exact release. Nightly probes intentionally omit these variables.
release_version="${TERMINUS_RELEASE_VERSION:-}"
release_commit="${TERMINUS_RELEASE_COMMIT:-}"
if [[ -n "$release_version" || -n "$release_commit" ]]; then
  [[ -n "$release_version" ]] || { echo "[linux-probe] TERMINUS_RELEASE_VERSION is required with release identity" >&2; exit 1; }
  [[ -n "$release_commit" ]] || { echo "[linux-probe] TERMINUS_RELEASE_COMMIT is required with release identity" >&2; exit 1; }
  [[ "$release_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
    echo "[linux-probe] TERMINUS_RELEASE_VERSION must be stable SemVer: $release_version" >&2
    exit 1
  }
  [[ "$release_commit" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
    echo "[linux-probe] TERMINUS_RELEASE_COMMIT must be a full Git object id" >&2
    exit 1
  }
  if [[ -n "${GITHUB_SHA:-}" && "$release_commit" != "$GITHUB_SHA" ]]; then
    echo "[linux-probe] release commit does not match GITHUB_SHA" >&2
    exit 1
  fi
  identity_report="$(mktemp "${report}.identity.XXXXXX")"
  jq --arg commit "$release_commit" --arg version "$release_version" \
    '. + {candidate_commit: $commit, release_version: $version}' \
    "$report" >"$identity_report"
  # The probe may run under sudo while the evidence producer runs as the
  # workflow user. Make the hand-off readable before the atomic rename.
  chmod 0644 "$identity_report"
  mv "$identity_report" "$report"
fi

echo "[linux-probe] effective enforcement verified: $report"
