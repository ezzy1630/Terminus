#!/usr/bin/env bash
# Verify that all patches under upstream/patches/ apply cleanly to the pinned OpenCode substrate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/upstream/opencode.lock.json"
PATCHES_DIR="$ROOT/upstream/patches"

commit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pinned"]["commit"])' "$LOCK")"
source_dir="$ROOT/vendor/opencode/$commit"

if [[ ! -d "$source_dir" ]]; then
  echo "[check-patches] imported OpenCode source not found at $source_dir" >&2
  exit 1
fi

patch_files=()
if [[ -d "$PATCHES_DIR" ]]; then
  while IFS= read -r f; do
    [[ -n "$f" ]] && patch_files+=("$f")
  done < <(find "$PATCHES_DIR" -type f -name '*.patch' | sort)
fi

echo "[check-patches] total patches in budget: ${#patch_files[@]}"

if [[ ${#patch_files[@]} -gt 0 ]]; then
  for patch in "${patch_files[@]}"; do
    echo "[check-patches] checking patch: $(basename "$patch")"
    if git apply --check --directory="vendor/opencode/$commit" "$patch" 2>/dev/null || patch --dry-run -p1 -d "$source_dir" < "$patch" >/dev/null 2>&1; then
      echo "[check-patches] OK: $(basename "$patch") applies cleanly"
    else
      echo "[check-patches] ERROR: patch $(basename "$patch") failed to apply cleanly to $commit" >&2
      exit 1
    fi
  done
fi

echo "[check-patches] all ${#patch_files[@]} patch(es) verified successfully"
exit 0
