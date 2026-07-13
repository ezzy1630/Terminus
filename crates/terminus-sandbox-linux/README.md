# terminus-sandbox-linux

Linux Bubblewrap backend for Terminus. It reports `Enforced` only when the
host has both a usable `bwrap` binary and a delegated, writable cgroup-v2
subtree. Otherwise secure profiles fail closed; no profile is silently reduced
to an unsandboxed process.

## Enforced boundary

For `Deny` and `ProxyRequired` network profiles, the launcher creates a new
user, PID, mount, and network namespace, runs on a read-only root, sets
`no_new_privs`, applies seccomp, and joins a bounded cgroup-v2 lease before
starting the payload. `ProxyRequired` exposes only the lease-owned egress
broker UDS; the payload cannot create direct network sockets.

The launcher must receive `TERMINUS_CGROUP_ROOT`, a dedicated cgroup-v2
subtree delegated by the service manager. It deliberately rejects the global
`/sys/fs/cgroup` root because the kernel cannot safely enable controllers or
create child leases there. Production service setup owns that delegation; the
GitHub Linux evidence workflow demonstrates the minimum host preparation.

## Host prerequisites

1. Install Bubblewrap (`bwrap`) and allow the required user/mount/PID/network
   namespaces.
2. Delegate an empty cgroup-v2 subtree with `cpu`, `memory`, and `pids`
   controllers enabled, then set `TERMINUS_CGROUP_ROOT` to that subtree.
3. Run the kernel from a protected executable path that Bubblewrap can execute
   under its mount policy.

Run `just linux-enforcement-evidence` on a prepared Linux host to produce and
verify the signed enforcement report. See
[`docs/runbooks/sandbox-unavailable.md`](../../docs/runbooks/sandbox-unavailable.md)
for recovery when a prerequisite is absent.
