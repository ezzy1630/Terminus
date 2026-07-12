# Runbook: Upstream OpenCode merge conflict

## When to use

Use this runbook when syncing with the pinned OpenCode upstream produces merge conflicts, or when the divergence budget (`upstream/divergence-budget.yaml`) is exceeded. This is governed by ADR-0002 (fork-assisted strangler) and SPEC §6.1, §42.2.

## Symptoms

- `git merge upstream/main` (or `git rebase upstream/main`) produces conflicts in inherited OpenCode files.
- Upstream sync CI fails.
- Divergence budget report shows merge-conflict hours exceeding the per-release cap.
- Parity test suite fails after an upstream sync.
- `upstream/divergence-budget.yaml` shows modified-file count exceeding the cap.

## Diagnosis

1. Check the current upstream pin:
   ```bash
   cat upstream/opencode.lock.json
   ```
2. Check the divergence budget:
   ```bash
   cat upstream/divergence-budget.yaml
   ```
3. Attempt the merge in a scratch branch:
   ```bash
   git fetch upstream
   git checkout -b upstream-sync-$(date +%Y%m%d) upstream/main
   git merge main  # or rebase
   ```
4. List conflicted files:
   ```bash
   git diff --name-only --diff-filter=U
   ```
5. For each conflict, determine: is this a Forge-owned change (intentional divergence) or an accidental edit?

## Immediate actions

1. **Do not force-push or abandon the merge.** The conflicts need to be resolved deliberately.
2. **Categorize each conflict:**
   - **Accidental edit to an inherited file:** revert the Forge-side edit; take the upstream version. Update `docs/security/effect-bypass-register.yaml` if the edit was a bypass.
   - **Intentional Forge-owned change (in an inherited file):** resolve the conflict manually, preserving the Forge-side semantics. Update `upstream/divergence-budget.yaml` with the file and the reason.
   - **Generic fix that should go upstream:** extract the fix, propose it upstream via PR, then take the upstream version once merged.
3. **Re-run parity tests after each resolution:**
   ```bash
   just upstream-check
   ```
4. **If the divergence budget is exceeded:** escalate to the upstream owner. Either:
   - Accelerate replacement of the affected package behind a Forge interface (ADR-0002 exit strategy), OR
   - Accept a temporary budget increase with a documented remediation plan.

## Recovery

1. Complete the merge/rebase in the scratch branch.
2. Run the full test suite:
   ```bash
   just check-all
   just upstream-check
   ```
3. Update `upstream/opencode.lock.json` with the new pinned commit.
4. Update `upstream/divergence-budget.yaml` with the new modified-file count and merge-conflict hours.
5. Merge the scratch branch to `main`.
6. Notify the team of the upstream sync.

## Post-incident

- File an incident report if the sync blocked a release.
- Add high-conflict files to the "replace behind Forge interface" list (ADR-0002 exit strategy).
- Propose generic fixes upstream to reduce future conflicts.
- Review the divergence budget — is it realistic? Adjust if needed.
- If a conflict introduced a regression, add a parity test for the affected behavior.

## Prevention

- Pin an exact upstream commit (SPEC §6.1, `upstream/opencode.lock.json`).
- Track modified files and merge-conflict hours (SPEC §6.1, `upstream/divergence-budget.yaml`).
- Set a maximum divergence budget per release (SPEC §6.1).
- Run upstream behavior-parity tests continuously (SPEC §6.1, `just upstream-check`).
- Propose generic fixes upstream (SPEC §6.1).
- Prohibit cosmetic refactors of upstream code (SPEC §6.1).
- Extract seams (ARP, Execution RPC, Context IR, artifact/evidence API, provider adapter interface) before adding differentiated features (SPEC §6.1).
- The strangler strategy (ADR-0002) continuously reduces the surface area of inherited code.

## Related

- `docs/runbooks/security-incident.md` — if the merge introduced a security regression.
- `docs/runbooks/eval-regression.md` — if the merge caused an eval regression.
- ADR-0002 (fork-assisted strangler), ADR-0026 (Bun isolated to bridge).
- SPEC §6.1 (divergence controls), §42.2 (upstream placement), §48.4 (M1 fork gate).
