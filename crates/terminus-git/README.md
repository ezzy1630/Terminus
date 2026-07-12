# terminus-git

Protected Git operations for the Terminus kernel.

`GitOps` runs structured `worktree`, `commit`, `branch`, and `merge`
operations by shelling out to a pinned `git` binary through
`forge_process::ProcessManager`. Every invocation sets
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_TEMPLATE_DIR=` (empty), and `core.hooksPath=/dev/null` so untrusted
hooks and config includes are disabled, and `--no-verify` so server-side
hooks cannot be invoked accidentally from the client (SPEC.md Section 14.5,
13.5).
