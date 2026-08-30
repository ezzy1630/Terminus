#!/usr/bin/env bash
# Fast, read-only Linux runner preflight for the real enforcement suite.
set -euo pipefail

[[ "$(uname -s)" == "Linux" ]] || { echo "Linux required" >&2; exit 1; }
command -v bwrap >/dev/null 2>&1 || { echo "bubblewrap missing" >&2; exit 1; }
bwrap --version >/dev/null || { echo "bubblewrap is not executable" >&2; exit 1; }

cgroup_root="${TERMINUS_CGROUP_ROOT:-}"
[[ -n "$cgroup_root" ]] || { echo "TERMINUS_CGROUP_ROOT is not configured" >&2; exit 1; }
[[ "$cgroup_root" == /* && "$cgroup_root" != "/sys/fs/cgroup" ]] \
  || { echo "cgroup root must be a dedicated absolute subtree: $cgroup_root" >&2; exit 1; }
[[ -r "$cgroup_root/cgroup.controllers" ]] || { echo "cgroup v2 unavailable at $cgroup_root" >&2; exit 1; }
[[ -w "$cgroup_root" ]] || { echo "cgroup root is not delegated writable: $cgroup_root" >&2; exit 1; }

# Exercise namespaces with a minimal root. An installed executable is not
# enough on hosted runners where unprivileged user namespaces are disabled.
bwrap_args=(
  --unshare-all
  --proc /proc
  --dev /dev
  --die-with-parent
  --new-session
  --cap-drop ALL
  --ro-bind /usr /usr
)
for runtime_tree in /lib /lib64; do
  if [[ -e "$runtime_tree" ]]; then
    bwrap_args+=(--ro-bind "$runtime_tree" "$runtime_tree")
  fi
done
bwrap "${bwrap_args[@]}" -- /usr/bin/true >/dev/null 2>&1 \
  || { echo "bubblewrap namespace probe failed" >&2; exit 1; }

bwrap --version
echo "cgroup root: $cgroup_root"
echo "cgroup controllers: $(tr '\n' ' ' <"$cgroup_root/cgroup.controllers")"
echo "seccomp status: $(grep -E '^Seccomp:' /proc/self/status | awk '{print $2}')"
