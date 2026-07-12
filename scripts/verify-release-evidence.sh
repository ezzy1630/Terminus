#!/usr/bin/env bash
# Validate the externally-produced Linux enforcement evidence required by the
# release gate (SPEC §36.5, §46.18, §50.5). A local machine must not be able
# to claim secure release readiness without evidence from a real Linux runner.
set -euo pipefail

evidence_path="${TERMINUS_LINUX_EVIDENCE:-}"
if [[ -z "$evidence_path" ]]; then
  echo "[release-evidence] TERMINUS_LINUX_EVIDENCE is required" >&2
  echo "[release-evidence] provide the immutable evidence manifest from the dedicated Linux sandbox runner" >&2
  exit 1
fi

if [[ ! -f "$evidence_path" ]]; then
  echo "[release-evidence] evidence manifest does not exist: $evidence_path" >&2
  exit 1
fi

required_patterns=(
  '^platform: linux$'
  '^profile: secure-local-default$'
  '^enforcement: enforced$'
  '^seccomp: active$'
  '^cgroup_v2: active$'
  '^network: proxy-only$'
  '^status: passed$'
)

for pattern in "${required_patterns[@]}"; do
  if ! grep -Eq "$pattern" "$evidence_path"; then
    echo "[release-evidence] missing required evidence field: $pattern" >&2
    exit 1
  fi
done

if grep -Eiq '(^|: )(skip|skipped|placeholder|unavailable|degraded)($|[[:space:]])' "$evidence_path"; then
  echo "[release-evidence] evidence contains a skipped, placeholder, unavailable, or degraded result" >&2
  exit 1
fi

echo "[release-evidence] validated $evidence_path"
