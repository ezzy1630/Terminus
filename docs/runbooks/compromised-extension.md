# Runbook: Compromised extension or MCP server

## When to use

Use this runbook when a third-party plugin, MCP server, or external harness adapter is suspected or confirmed to be compromised (malicious code, descriptor rug-pull, supply-chain attack, escape attempt). This is a security incident — see also `docs/runbooks/security-incident.md`.

## Symptoms

- Extension/MCP descriptor hash changed without user action (rug-pull, SPEC §35.3).
- Extension process attempts to access resources outside its declared capabilities.
- Security evals flag the extension (`evals/security/mcp-poisoning.yaml`, `workspace-escape.yaml`).
- Audit log shows the extension producing taint-tracked output that reached a privileged effect.
- External notification (npm, PyPI, crate registry, MCP directory) that the package is malicious.
- User reports unexpected behavior from an extension.

## Diagnosis

1. **Quarantine immediately** (see Immediate actions) before diagnosing.
2. Check the extension's descriptor hash against the pinned hash:
   ```bash
   sqlite3 db/terminus.db "SELECT id, name, version, descriptor_hash, pinned_hash, status FROM capabilities WHERE type IN ('mcp_server', 'plugin') AND status = 'active';"
   ```
3. Check the audit log for the extension's recent activity:
   ```bash
   sqlite3 db/terminus.db "SELECT * FROM capability_audit WHERE capability_id = '<id>' ORDER BY occurred_at DESC LIMIT 100;"
   ```
4. Check for taint-tracked output from the extension:
   ```bash
   sqlite3 db/terminus.db "SELECT * FROM tool_calls WHERE capability_id = '<id>' AND taint_sources IS NOT NULL ORDER BY started_at DESC LIMIT 50;"
   ```
5. Check the extension's process for unexpected behavior (network connections, file access).

## Immediate actions

1. **Revoke the extension's capability:**
   ```bash
   grpcurl -plaintext -unix /var/run/terminus-kernel.sock terminus.kernel.v1.CapabilityService/Revoke '{"capability_id": "<id>"}'
   ```
2. **Kill the extension's process:**
   ```bash
   # The kernel owns extension processes; revoking the capability should kill it
   # Verify:
   ps aux | grep -F "<extension-process>"
   ```
3. **Quarantine the extension** (do not delete — it's evidence):
   ```bash
   mkdir -p quarantine/extension-<date>
   mv <extension-install-path> quarantine/extension-<date>/
   ```
4. **Mark the extension as `quarantined` in the registry:**
   ```bash
   sqlite3 db/terminus.db "UPDATE capabilities SET status = 'quarantined', quarantined_at = datetime('now'), quarantine_reason = 'suspected compromise' WHERE id = '<id>';"
   ```
5. **Notify affected sessions/tasks** — they may have used the extension's tainted output.
6. **Review taint propagation** — did the extension's output reach a privileged effect? If so, that effect may need to be rolled back or re-reviewed.

## Recovery

1. Identify a safe replacement for the extension (if one exists) or proceed without it.
2. For sessions/tasks that used the extension's tainted output:
   - Re-run from a checkpoint before the extension was activated, OR
   - Manually review the affected work and decide whether to keep or redo it.
3. Run the security eval suite (`just security`) to verify no other extensions are compromised.
4. Run the malicious plugin/MCP suite (SPEC §46.10) to verify the quarantine is effective.

## Post-incident

- File a security incident report (`docs/runbooks/security-incident.md`).
- Report the malicious package to the registry (npm, PyPI, crates.io, MCP directory).
- Add the malicious behavior to the security evals.
- Review the descriptor-pinning and reauthorization flow — why didn't it catch this earlier?
- If the extension escaped its sandbox, treat as a sandbox escape incident and review the sandbox backend (ADR-0014).
- Audit all other active extensions for similar patterns.

## Prevention

- Descriptor pinning with hash verification (SPEC §35.3, ADR-0018).
- Reauthorization on descriptor change (SPEC §35.3).
- Out-of-process/WASI isolation (ADR-0019).
- Per-tool capability classification (SPEC §35.3).
- Taint tracking on all extension output (SPEC §36.15).
- No lifecycle scripts (SPEC §36.4).
- Explicit installation with lockfiles and signatures (SPEC §35.4).
- Malicious plugin/MCP suite runs nightly (SPEC §46.10).
- Security evals: `mcp-poisoning.yaml`, `workspace-escape.yaml`, `prompt-injection.yaml` (SPEC §41.11).

## Related

- `docs/runbooks/security-incident.md` — full incident response.
- `docs/runbooks/leaked-credential.md` — if the extension leaked a credential.
- `docs/architecture/trust-boundaries.md` — extension isolation design.
- SPEC §12 (skills/MCP/plugins), §35 (impl), §36.15 (taint), §41.11 (security evals).
