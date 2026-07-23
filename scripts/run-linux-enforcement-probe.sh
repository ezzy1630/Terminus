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

echo "[linux-probe] effective enforcement verified: $report"
