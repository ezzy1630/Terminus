#!/usr/bin/env bash
# Fast, read-only Linux runner preflight for the real enforcement suite.
set -euo pipefail

[[ "$(uname -s)" == "Linux" ]] || { echo "Linux required" >&2; exit 1; }
command -v bwrap >/dev/null 2>&1 || { echo "bubblewrap missing" >&2; exit 1; }
[[ -r /sys/fs/cgroup/cgroup.controllers ]] || { echo "cgroup v2 unavailable" >&2; exit 1; }
[[ -w /sys/fs/cgroup ]] || { echo "cgroup root is not delegated writable" >&2; exit 1; }
bwrap --version
echo "cgroup controllers: $(tr '\n' ' ' </sys/fs/cgroup/cgroup.controllers)"
echo "seccomp status: $(grep -E '^Seccomp:' /proc/self/status | awk '{print $2}')"
