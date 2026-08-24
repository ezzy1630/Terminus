# Runbook: Sandbox unavailable

## When to use

Use this runbook when the kernel reports that the requested sandbox backend cannot be enforced (e.g., Bubblewrap not installed on Linux, macOS backend unavailable, Windows backend degraded, container runtime unavailable). Per SPEC §26.3 #11, Terminus MUST fail closed or require explicit user selection of a named degraded profile.

## Symptoms

- Kernel `Health` returns `degraded` or `failing` with sandbox-related `degradations`.
- `StartProcessRequest` denied with `sandbox_unavailable`.
- UI displays "enforcement degraded" warning.
- Linux: `bubblewrap not found`, `unshare: Operation not permitted`, or
  `delegated cgroup root unavailable`.
- macOS: `sandbox-exec: command not found` or profile syntax error.
- Windows: `Job Object creation failed`.
- Container backend: `container runtime not available`.

## Diagnosis

1. Check kernel health:
   ```bash
   grpcurl -plaintext -unix /var/run/terminus-kernel.sock terminus.kernel.v1.KernelInfoService/Health
   ```
2. Check sandbox backend availability:
   ```bash
   # Linux
   which bwrap
   bwrap --ro-bind / / true  # Test basic functionality
   # macOS
   which sandbox-exec
   # Windows (PowerShell)
   Get-Command sandbox-exec 2>$null  # (Windows doesn't have sandbox-exec; check for alternative)
   # Container
   which podman || which docker
   ```
3. Check kernel capabilities log for the backend's self-reported capabilities.
4. Check kernel logs for sandbox construction errors.
5. For secure Linux profiles, confirm the kernel received a dedicated cgroup-v2
   root (not `/sys/fs/cgroup`) and that `cpu`, `memory`, and `pids` are enabled
   for child leases:
   ```bash
   printf '%s\n' "$TERMINUS_CGROUP_ROOT"
   cat "$TERMINUS_CGROUP_ROOT/cgroup.controllers"
   cat "$TERMINUS_CGROUP_ROOT/cgroup.subtree_control"
   ```

## Immediate actions

1. **Do not silently fall back to no sandbox** (SPEC §26.3 #11). Terminus must fail closed or require explicit degraded-profile selection.
2. **For Linux Bubblewrap missing:**
   ```bash
   # Debian/Ubuntu
   sudo apt install bubblewrap
   # Fedora
   sudo dnf install bubblewrap
   # Arch
   sudo pacman -S bubblewrap
   ```
3. **For Linux `unshare: Operation not permitted` (container/host restriction):**
   - The host kernel may not allow user namespaces. Enable:
     ```bash
     sudo sysctl -w kernel.unprivileged_userns_clone=1
     ```
   - Or run Terminus with `--sandbox=degraded-local` (named degraded profile) — but only if the user explicitly accepts the risk.
4. **For Linux `delegated cgroup root unavailable`:** configure the service
   manager to delegate an otherwise empty cgroup-v2 subtree and enable the
   `cpu`, `memory`, and `pids` controllers for children. Set
   `TERMINUS_CGROUP_ROOT` to that subtree. Do not point it at the global
   `/sys/fs/cgroup` root; the backend rejects that unsafe configuration.
5. **For macOS unavailable:** fail closed. Install or restore `sandbox-exec`, or select another enforcing backend such as Linux Bubblewrap or a container. Do not accept an unnamed degraded macOS profile.
6. **For Windows degraded:** the Windows backend honestly reports degraded capability. Accept degraded mode or move to Linux.
7. **For container backend missing:** install Podman or Docker, or use a different backend (ADR-0027).

## Recovery

1. Install/enable the missing backend.
2. Restart the kernel:
   ```bash
   just run-kernel
   ```
3. Verify `Health` returns `healthy` with no degradations.
4. Run a sample `StartProcessRequest` to verify sandbox construction works.
5. Run the sandbox adversarial suite (`just security`) to verify enforcement.

## Post-incident

- File an incident report if production was affected.
- Add the backend availability check to the startup health check.
- Document the degraded-profile selection in the user guide.
- If running in a container/host that doesn't allow user namespaces, document the workaround.

## Prevention

- Pre-flight check at startup verifies sandbox backend availability (SPEC §46.17).
- Health endpoint reports degradations (SPEC §47.8).
- UI displays "enforcement degraded" when applicable (SPEC §26.2).
- Named degraded profiles (`policies/sandbox/degraded-local.yaml`) are explicit, not silent (SPEC §13.4, §36.4).
- Sandbox adversarial suite runs nightly (SPEC §46.10).

## Related

- `docs/runbooks/security-incident.md` — if sandbox unavailability led to a bypass.
- `docs/architecture/trust-boundaries.md` — non-bypassability invariant.
- `docs/security/non-bypassability-tests.md` — the test plan.
- SPEC §13.4 (OS backends), §36.4 (default policy), §36.5–§36.8 (per-backend), §26.3 #11 (no unreported degradation).
