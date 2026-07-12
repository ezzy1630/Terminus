#!/bin/bash
# Establish a real OpenCode upstream pin (SPEC §6.1, ADR-0002).
#
# Usage: scripts/pin-upstream.sh <repo-url> <commit-sha> [ref]
#
# Downloads the immutable commit-addressed archive, sha256-hashes the tarball,
# and writes a verified `pinned` record to upstream/opencode.lock.json.
set -eu

if [ $# -lt 2 ]; then
  echo "usage: $0 <repo-url> <commit-sha> [ref]" >&2
  exit 1
fi
REPO="$1"
COMMIT="$2"
REF="${3:-dev}"

case "$COMMIT" in
  *[!0-9a-f]*|'') echo "commit must be a lowercase hexadecimal SHA" >&2; exit 1 ;;
esac
if [ "${#COMMIT}" -ne 40 ]; then
  echo "commit must contain exactly 40 hexadecimal characters" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/upstream/opencode.lock.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ARCHIVE_URL="$REPO/archive/$COMMIT.tar.gz"
curl --fail --location --silent --show-error "$ARCHIVE_URL" --output "$TMP/archive.tar.gz"
HASH="sha256:$(shasum -a 256 "$TMP/archive.tar.gz" | awk '{print $1}')"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "[pin-upstream] commit=$COMMIT content_sha256=$HASH"

python3 - "$LOCK" "$REPO" "$COMMIT" "$REF" "$HASH" "$NOW" "$ARCHIVE_URL" <<'PY'
import json, sys
lock, repo, commit, ref, h, now, archive_url = sys.argv[1:8]
d = json.load(open(lock))
d["status"] = "pinned"
d["pinned"] = {
    "repo": repo,
    "commit": commit,
    "ref": ref,
    "retrieved_at": now,
    "archive_url": archive_url,
    "content_sha256": h,
    "note": "Verified by scripts/pin-upstream.sh using an immutable commit-addressed archive."
}
d["blockers"] = []
json.dump(d, open(lock, "w"), indent=2)
print("[pin-upstream] wrote verified pin to", lock)
PY
