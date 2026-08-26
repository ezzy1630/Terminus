#!/usr/bin/env bash
# Apply or verify the checked-in mainline ruleset.
#
# The default action is a read-only plan. Set
# TERMINUS_APPLY_GITHUB_RULESET=1 only after reviewing the exact repository and
# desired payload. No token or response body is printed.
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_path="$root_dir/.github/rulesets/main.json"

fail() {
  echo "[github-ruleset] $*" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || fail "gh is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
[[ -f "$config_path" ]] || fail "ruleset config is missing: $config_path"
jq -e 'type == "object" and .name == "main-protection" and .target == "branch" and .enforcement == "active" and (.bypass_actors | type == "array" and length == 0)' "$config_path" >/dev/null \
  || fail "ruleset config is invalid or has an unrestricted bypass"

repository="${TERMINUS_GITHUB_REPOSITORY:-}"
if [[ -z "$repository" ]]; then
  repository="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
fi
[[ "$repository" =~ ^[^/]+/[^/]+$ ]] || fail "repository must be owner/name; set TERMINUS_GITHUB_REPOSITORY"

ruleset_name="$(jq -r '.name' "$config_path")"
ruleset_id="$(gh api "repos/$repository/rulesets" | jq -r --arg name "$ruleset_name" '.[] | select(.name == $name) | .id' | head -n 1)"

if [[ "${TERMINUS_VERIFY_GITHUB_RULESET:-}" == "1" ]]; then
  [[ -n "$ruleset_id" ]] || fail "active $ruleset_name ruleset is absent from $repository"
  actual="$(gh api "repos/$repository/rulesets/$ruleset_id")"
  jq -e --argjson expected "$(cat "$config_path")" '
    .name == $expected.name and
    .target == $expected.target and
    .enforcement == $expected.enforcement and
    (.bypass_actors | length == 0) and
    ([.rules[].type] | index("deletion")) != null and
    ([.rules[].type] | index("non_fast_forward")) != null and
    ([.rules[].type] | index("pull_request")) != null and
    ([.rules[].type] | index("required_status_checks")) != null
  ' <<<"$actual" >/dev/null || fail "remote ruleset does not match the required protected-main shape"
  echo "[github-ruleset] verified active ruleset $ruleset_name on $repository"
  exit 0
fi

if [[ -n "$ruleset_id" ]]; then
  echo "[github-ruleset] would update ruleset $ruleset_name (id $ruleset_id) on $repository"
else
  echo "[github-ruleset] would create ruleset $ruleset_name on $repository"
fi

if [[ "${TERMINUS_APPLY_GITHUB_RULESET:-}" != "1" ]]; then
  echo "[github-ruleset] read-only plan complete; set TERMINUS_APPLY_GITHUB_RULESET=1 to apply"
  exit 0
fi

if [[ -n "$ruleset_id" ]]; then
  gh api --method PUT "repos/$repository/rulesets/$ruleset_id" --input "$config_path" >/dev/null
else
  gh api --method POST "repos/$repository/rulesets" --input "$config_path" >/dev/null
fi
echo "[github-ruleset] applied $ruleset_name to $repository"
