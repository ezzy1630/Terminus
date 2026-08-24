#!/usr/bin/env bash
# Verify cryptographically bound Linux enforcement evidence.
set -euo pipefail

evidence_path="${TERMINUS_LINUX_EVIDENCE:-}"
signature_path="${TERMINUS_LINUX_EVIDENCE_SIGNATURE:-}"
certificate_path="${TERMINUS_LINUX_EVIDENCE_CERTIFICATE:-}"
expected_commit="${TERMINUS_RELEASE_COMMIT:-${GITHUB_SHA:-}}"

fail() {
  echo "[release-evidence] $*" >&2
  exit 1
}

[[ -n "$evidence_path" ]] || fail "TERMINUS_LINUX_EVIDENCE is required"
[[ -f "$evidence_path" ]] || fail "evidence manifest does not exist: $evidence_path"
[[ -n "$signature_path" && -f "$signature_path" ]] || fail "signed evidence signature is required"
[[ -n "$certificate_path" && -f "$certificate_path" ]] || fail "signed evidence certificate is required"
command -v cosign >/dev/null 2>&1 || fail "cosign is required to verify signed evidence"

jq -e 'type == "object"' "$evidence_path" >/dev/null || fail "evidence manifest is not valid JSON"

required_paths=(
  '.schema_version'
  '.terminus_commit'
  '.runner.os'
  '.runner.kernel'
  '.sandbox.bubblewrap_version'
  '.sandbox.seccomp_filter_sha256'
  '.sandbox.cgroup_mode'
  '.sandbox.network_mode'
  '.test_suite_sha256'
  '.command'
  '.exit_status'
  '.tests'
  '.artifact_digests'
  '.generated_at'
  '.ci.run_url'
  '.ci.identity'
)
for path in "${required_paths[@]}"; do
  jq -e "${path} != null and ${path} != \"\"" "$evidence_path" >/dev/null || fail "missing evidence field: $path"
done

jq -e '
  .schema_version == 1 and
  .runner.os == "linux" and
  .sandbox.network_mode == "deny" and
  .sandbox.cgroup_mode == "v2" and
  (.tests | type == "array" and length > 0) and
  (.tests | all(.[]; .status == "passed" and (.artifact_digest | type == "string"))) and
  (.artifact_digests | type == "object" and length > 0) and
  (.exit_status == 0)
' "$evidence_path" >/dev/null || fail "evidence does not prove the required enforced Linux profile"

if [[ -n "$expected_commit" ]]; then
  actual_commit="$(jq -r '.terminus_commit' "$evidence_path")"
  [[ "$actual_commit" == "$expected_commit" ]] || fail "manifest commit $actual_commit is not bound to release commit $expected_commit"
fi

# Bind the keyless certificate to THIS repository's CI workflows by default.
# The previous default (https://github.com/.+/.github/workflows/.+) accepted
# evidence signed by any repository, so a fork could mint a passing manifest.
# Override only with an equally strict identity when running outside GitHub
# Actions (where GITHUB_REPOSITORY is unset).
if [[ -z "${TERMINUS_EVIDENCE_CERTIFICATE_IDENTITY:-}" ]]; then
  if [[ -z "${GITHUB_REPOSITORY:-}" ]]; then
    fail "refusing to verify with a broad certificate identity: set GITHUB_REPOSITORY or TERMINUS_EVIDENCE_CERTIFICATE_IDENTITY"
  fi
  TERMINUS_EVIDENCE_CERTIFICATE_IDENTITY="https://github.com/${GITHUB_REPOSITORY}/.github/workflows/.+"
fi

cosign verify-blob \
  --certificate "$certificate_path" \
  --signature "$signature_path" \
  --certificate-identity-regexp "$TERMINUS_EVIDENCE_CERTIFICATE_IDENTITY" \
  --certificate-oidc-issuer "${TERMINUS_EVIDENCE_OIDC_ISSUER:-https://token.actions.githubusercontent.com}" \
  "$evidence_path" >/dev/null || fail "evidence signature verification failed"

echo "[release-evidence] verified signed manifest: $evidence_path"
