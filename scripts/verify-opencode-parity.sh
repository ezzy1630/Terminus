#!/usr/bin/env bash
# Run parity checks against the exact immutable OpenCode import.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
commit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pinned"]["commit"])' "$ROOT/upstream/opencode.lock.json")"
source_dir="$ROOT/vendor/opencode/$commit"
overlay_dir="$ROOT/upstream/overlays/$commit"

[[ -d "$source_dir" ]] || { echo "[opencode-parity] imported source is missing: $source_dir" >&2; exit 1; }
[[ -f "$source_dir/.terminus-source-verified" ]] || { echo "[opencode-parity] source provenance marker is missing" >&2; exit 1; }
[[ -f "$source_dir/package.json" ]] || { echo "[opencode-parity] imported source has no package manifest" >&2; exit 1; }

echo "[opencode-parity] checking immutable source $commit"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
cp -a "$source_dir/." "$tmp_dir/"
if [[ -d "$overlay_dir" ]]; then
  while IFS= read -r overlay; do
    patch --directory="$tmp_dir" --forward --batch -p1 <"$overlay"
  done < <(find "$overlay_dir" -type f -name '*.patch' | sort)
fi
cd "$tmp_dir"
bun install --frozen-lockfile --ignore-scripts
bun turbo typecheck
