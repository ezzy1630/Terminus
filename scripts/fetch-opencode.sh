#!/usr/bin/env bash
# Fetch the immutable OpenCode source selected by upstream/opencode.lock.json.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/upstream/opencode.lock.json"
commit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pinned"]["commit"])' "$lock")"
archive_url="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pinned"]["archive_url"])' "$lock")"
expected="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pinned"]["content_sha256"])' "$lock")"
destination="$root/vendor/opencode/$commit"

if [[ -f "$destination/.terminus-source-verified" ]]; then
  echo "[opencode] immutable source already present: $destination"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl --fail --location --silent --show-error "$archive_url" --output "$tmp/opencode.tar.gz"
actual="sha256:$(sha256sum "$tmp/opencode.tar.gz" | awk '{print $1}')"
[[ "$actual" == "$expected" ]] || {
  echo "[opencode] archive digest mismatch: expected $expected, got $actual" >&2
  exit 1
}

mkdir -p "$destination"
tar -xzf "$tmp/opencode.tar.gz" --strip-components=1 -C "$destination"
{
  echo "repo=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pinned"]["repo"])' "$lock")"
  echo "commit=$commit"
  echo "archive_sha256=$actual"
} > "$destination/.terminus-source-verified"
echo "[opencode] fetched and verified $commit"
