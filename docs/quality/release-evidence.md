# Release evidence

How M12 release evidence is produced and verified. Maps to
`docs/quality/release-gates.md` (SPEC §46.14–§46.18, §50).

## Produce

| Evidence | Producer | Output |
|---|---|---|
| Fuzz / property smoke | `scripts/run-fuzz-smoke.sh` | `fuzz-smoke.json`, `property-tests.json` |
| Fault injection (§46.9) | `scripts/run-fault-injection.ts` | `fault-injection.json` (fixture matrix plus explicitly labeled DB-backed scenarios) |
| Upgrade / rollback | `bun test tests/release/upgrade_rollback_drill.test.ts` | `upgrade-rollback.json` |
| Backup / restore | `bun test tests/release/backup_restore_drill.test.ts` | (test-only; covered by upgrade drill evidence) |
| Clean install / downgrade | `bun test tests/release/clean_install_upgrade_downgrade.test.ts` | (test-only) |
| Soak / RSS | `scripts/soak-leak-test.sh` | `soak-leak.json` |
| Preview canary | `scripts/preview-canary.sh` | `preview-canary.json` |
| Ops metrics | `scripts/collect-ops-metrics.ts` | `ops-metrics.json` |
| Eval release | `scripts/run-release-evals.sh` | `eval-release.json` |
| SBOM | `scripts/verify-sbom-local.sh` | `sbom-verify.json` |
| Schema freeze | `scripts/write-schema-freeze-evidence.ts` | `schema-freeze.json` |
| Nightly security job outcome | `scripts/run-security-job.sh` | one typed result per job with product, dependency, or runner classification |
| macOS Seatbelt enforcement | release workflow live tests + `just platform-probes` | signed `macos-enforcement.json` and `macos-platform-probes.json` |
| Findings status | `scripts/m12-exit-gate.ts` | `findings-register-status.json` |
| Candidate evidence manifest | `scripts/produce-release-evidence-manifest.ts` | `release-evidence-manifest.json` |
| Release decision (§50.10) | `scripts/produce-release-decision.ts` | `release-decision.yaml` |
| Exit gate aggregate | `scripts/m12-exit-gate.ts` | `exit-gate-report.json`, `exit-gate-checklist.md` |

All paths are under `artifacts/release-gate/` unless noted.

The fault-injection artifact separates the in-memory fixture matrix from
DB-backed evidence. A passing producer means the recorded tests passed; it
does not mean every SPEC §46.9 boundary has production-equivalent proof.
The current DB-backed subset covers repair scheduling rollback, parent/child
admission replay, fenced lease settlement, checkpoint publication replay, and
completion-record admission replay. `completeForRelease` remains false until
the remaining provider, effect, migration, cancellation, and other durable
boundaries have equivalent coverage.

Release evidence is produced only from a clean checkout at the exact candidate
commit. `just release-source-check` rejects dirty or mismatched source before a
release decision or aggregate M12 report can be minted. Use `just check-all`
and `just e2e` for useful working-tree validation before the candidate is
committed.

## Candidate identity

Every stable-release evidence item is bound to one candidate commit and one
release version. An artifact can carry the canonical fields directly:

```json
{
  "candidate_commit": "<full git object id>",
  "release_version": "<exact version>"
}
```

The validator also recognizes the documented commit aliases `commit`,
`source_commit`, and `terminus_commit`, plus the version alias
`terminus_version`. If an artifact contains more than one alias, every value
must agree. These aliases are the only approved direct equivalents; a generic
`version` field does not prove release identity.

Evidence producers that do not write candidate identity are covered by
`release-evidence-manifest.json`. The manifest records the exact commit,
version, repository-relative path, and SHA-256 digest for every required
artifact. Changing an artifact after manifest creation invalidates the gate.
The manifest itself carries the canonical identity fields.

Produce the candidate evidence in a clean checkout before collecting
approvals:

```bash
TERMINUS_RELEASE_COMMIT=<commit> \
TERMINUS_RELEASE_VERSION=<version> \
just release-evidence-candidate
```

Do not rerun an evidence producer after approval. Produce a new manifest and
collect new approvals instead.

## Owner approval artifacts

The four approval environment variables name JSON files. Raw strings are
rejected:

```text
TERMINUS_RELEASE_OWNER_APPROVAL
TERMINUS_SECURITY_OWNER_APPROVAL
TERMINUS_PROTOCOL_OWNER_APPROVAL
TERMINUS_EVALUATION_OWNER_APPROVAL
```

Each file is a `terminus.release-approval-envelope.v1` envelope. Its
`signed_payload` is the exact canonical UTF-8 JSON string signed with Ed25519.
Canonical order is `schema`, `role`, `identity`, `candidate_commit`,
`release_version`, `evidence_manifest_sha256`, `issued_at`, then `expires_at`:

```json
{
  "schema": "terminus.release-approval-envelope.v1",
  "algorithm": "ed25519",
  "key_id": "<trusted key id>",
  "signed_payload": "{\"schema\":\"terminus.release-approval.v1\",...}",
  "signature_base64": "<base64 Ed25519 signature>"
}
```

The signed payload contains `role`, `identity`, `candidate_commit`,
`release_version`, `evidence_manifest_sha256`, `issued_at`, and `expires_at`.
`issued_at` and `expires_at` use canonical UTC ISO-8601 timestamps. Expired,
future-dated, wrong-role, wrong-candidate, or wrong-manifest approvals fail.
The source contracts live in `schemas/release/approval-payload.json` and
`schemas/release/approval-envelope.json`.

`TERMINUS_RELEASE_APPROVAL_TRUST_STORE` names a JSON trust registry with schema
`terminus.release-approval-trust.v1`. Each key entry binds `key_id` to one
identity, allowed owner roles, an Ed25519 public key, optional validity dates,
and revocation status. A public key supplied only by the approval envelope is
not trusted. The trust registry must resolve outside the candidate checkout so
the candidate cannot add its own trust anchor. The release environment owns
this registry and the corresponding private keys; the repository contains
neither fake approvals nor private keys.
The registry contract lives in
`schemas/release/approval-trust-store.json`; the manifest contract lives in
`schemas/release/evidence-manifest.json`.

After all four owners sign the same manifest digest, produce and verify the
decision without regenerating evidence:

```bash
just release-decision
just m12-exit-gate
```

The decision embeds each signed envelope. `m12-exit-gate.ts` re-verifies all
four signatures against the trust registry, candidate identity, current time,
and manifest digest. A producer's `verified: true` field is never accepted on
its own.

LibFuzzer campaigns live in `fuzz/`; CI/release uses `fuzz-smoke` rather than
long campaigns (see `fuzz/README.md`).

The nightly workflow also runs a required short LibFuzzer campaign with the
nightly toolchain selected on every `cargo` invocation. Hosted Linux
enforcement checks are diagnostic only. An incapable hosted runner emits
`classification: non_promotable_environment`; it cannot become release
evidence. Signed Linux evidence runs only on a self-hosted runner labeled
`linux`, `x64`, and `terminus-enforcement`, with
`/sys/fs/cgroup/terminus-ci` pre-delegated to the Actions user.

## Verify

```bash
bun run scripts/m12-exit-gate.ts
```

The exit gate fails if a required file is missing, invalid, stale, has
contradictory candidate fields, is absent from the evidence manifest, or has a
different digest. Linux enforcement evidence must carry the exact candidate
commit and version. It is `verified` when the dedicated CI evidence and
signature inputs are present; otherwise status is `requires_ci`, not a silent
skip.

## Map to release-gates.md

| Gate item | Evidence |
|---|---|
| Platform checks / Linux sandbox | `TERMINUS_LINUX_EVIDENCE` + linux check in exit gate |
| macOS Seatbelt sandbox | signed macOS job result + effective-control probe matrix |
| No unresolved critical findings | `findings-register-status.json` + `docs/security/findings-register.yaml` |
| Migration and recovery (§46.9, §50.2) | `fault-injection.json`, `upgrade-rollback.json`, release drills |
| Default policy/eval non-regression | `eval-release.json`, `fuzz-smoke.json` |
| Schemas published / frozen | `schema-freeze.json` ← `schemas/STABLE_VERSIONS.yaml` |
| Canary / soak (§46.16) | `preview-canary.json`, `soak-leak.json`, `ops-metrics.json` |
| Signed artifacts / SBOM (§46.14–15) | `sbom-verify.json` |
| Final acceptance (§50.10) | `release-decision.yaml` |

## Related

- `docs/quality/release-gates.md`
- `docs/operations/operational-metrics.md`
- `docs/security/findings-register.yaml`
- `fuzz/README.md`
