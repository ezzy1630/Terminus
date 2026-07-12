#!/bin/bash
# Verify the OpenCode upstream pin (SPEC §6.1, ADR-0002, M1 exit gate).
#
# A real pin is a tuple: { repo, commit, content_sha256 } where
# content_sha256 == sha256(git archive --format=tar.gz <commit>). This script
# downloads the immutable commit-addressed source archive, hashes it, and compares.
#
# Exit codes:
#   0  pin is present and verified (content_sha256 matches)
#   1  pin is pending (lockfile status != "pinned") — honest, not an error
#   2  pin claims verified but the hash does NOT match — INTEGRITY FAILURE
#   3  lockfile is malformed or the fetch/archive failed
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/upstream/opencode.lock.json"

if [ ! -f "$LOCK" ]; then
  echo "[verify-pin] missing $LOCK" >&2
  exit 3
fi

STATUS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$LOCK" 2>/dev/null || echo '')"
if [ "$STATUS" != "pinned" ]; then
  echo "[verify-pin] lockfile status='$STATUS' (not pinned). Pin is pending — this is honest, not a failure."
  echo "[verify-pin] To establish a real pin:"
  echo "  1. Choose a real OpenCode commit."
  echo "  2. Run: scripts/pin-upstream.sh <repo-url> <commit-sha>"
  echo "  3. Re-run this script to verify."
  exit 1
fi

REPO="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pinned",{}).get("repo",""))' "$LOCK")"
COMMIT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pinned",{}).get("commit",""))' "$LOCK")"
EXPECTED="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pinned",{}).get("content_sha256",""))' "$LOCK")"
ARCHIVE_URL="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pinned",{}).get("archive_url",""))' "$LOCK")"

if [ -z "$REPO" ] || [ -z "$COMMIT" ] || [ -z "$EXPECTED" ] || [ -z "$ARCHIVE_URL" ]; then
  echo "[verify-pin] lockfile marked pinned but missing repo/commit/archive_url/content_sha256" >&2
  exit 3
fi

case "$COMMIT" in
  *[!0-9a-f]*|'') echo "[verify-pin] commit is not a lowercase hexadecimal SHA" >&2; exit 3 ;;
esac
if [ "${#COMMIT}" -ne 40 ]; then
  echo "[verify-pin] commit must contain exactly 40 hexadecimal characters" >&2
  exit 3
fi
EXPECTED_URL="$REPO/archive/$COMMIT.tar.gz"
if [ "$ARCHIVE_URL" != "$EXPECTED_URL" ]; then
  echo "[verify-pin] archive_url is not bound to repo + commit" >&2
  exit 3
fi

echo "[verify-pin] repo=$REPO commit=$COMMIT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl --fail --location --silent --show-error "$ARCHIVE_URL" --output "$TMP/archive.tar.gz"
ACTUAL="sha256:$(shasum -a 256 "$TMP/archive.tar.gz" | awk '{print $1}')"

echo "[verify-pin] expected=$EXPECTED"
echo "[verify-pin] actual=  $ACTUAL"

if [ "$ACTUAL" = "$EXPECTED" ]; then
  echo "[verify-pin] OK — content_sha256 verified"
  exit 0
else
  echo "[verify-pin] INTEGRITY FAILURE — content_sha256 mismatch" >&2
  exit 2
fi
