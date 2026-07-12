# Runbook: Kernel/control version mismatch

## When to use

Use this runbook when the control plane (`forge-control`) and the kernel (`forge-kernel`) report incompatible versions, when capability tokens are rejected, or when RPC schemas don't match. The kernel protocol uses buf breaking-change checks (SPEC §45.4) but a running deployment may still end up with mismatched versions after a partial upgrade.

## Symptoms

- Control plane logs: `capability token rejected` or `unknown RPC method`.
- Kernel logs: `unsupported RPC version` or `invalid RequestContext`.
- `KernelInfoService.GetInfo` returns a `protocol_version` that doesn't match what the control plane expects.
- Streaming RPCs fail immediately with schema errors.
- New fields are silently dropped (use `buf breaking` to detect).

## Diagnosis

1. Check versions from both sides:
   ```bash
   # Kernel
   grpcurl -plaintext -unix /var/run/forge-kernel.sock forge.kernel.v1.KernelInfoService/GetInfo
   # Control plane
   curl http://localhost:3050/health
   ```
2. Compare `protocol_version`, `version`, and `build_revision`.
3. Check the buf descriptor set bundled with each binary.
4. Review the upgrade log for partial failures.

## Immediate actions

1. **Determine which side is ahead.** Usually the kernel should be upgraded first (it's backward compatible with older control planes within a compatibility window, SPEC §46.17).
2. **If control plane is ahead of kernel:** downgrade the control plane to match the kernel, OR upgrade the kernel to match.
3. **If kernel is ahead of control plane (within compatibility window):** no action needed; the kernel should support the older control plane.
4. **If kernel is ahead of control plane (outside compatibility window):** upgrade the control plane immediately, or roll back the kernel.
5. **If capability tokens are rejected:** restart both. Tokens are short-lived; a restart re-issues them.

## Recovery

1. Upgrade/downgrade the mismatched side to match.
2. Restart both processes:
   ```bash
   just run-kernel &
   just run-control &
   ```
3. Verify `KernelInfoService.Health` returns `healthy`.
4. Verify a sample RPC (e.g., `FileService.Read` on a known file).
5. Run the contract test suite (SPEC §46.6) for current×current.

## Post-incident

- File an incident report.
- Add the version combination to the contract test matrix (SPEC §46.6).
- Review the upgrade procedure (SPEC §46.17) — the compatibility window should be explicit.
- Verify CI runs `buf breaking` against the previous release descriptor.

## Prevention

- Upgrade kernel first, then control plane (SPEC §46.17).
- Maintain a documented compatibility window (e.g., kernel N supports control plane N and N-1).
- Run `buf breaking` in CI (SPEC §45.4).
- Contract tests: current×current and current×previous (SPEC §46.6).
- Pin both versions in deployment manifests.
- Health check includes `protocol_version` comparison.

## Related

- `docs/runbooks/orphaned-jobs.md` — jobs may reference a kernel that's gone.
- `docs/runbooks/sandbox-unavailable.md` — kernel may report degraded sandbox.
- SPEC §31.1 (service groups), §45.4 (protobuf compatibility), §46.17 (upgrade/rollback).
