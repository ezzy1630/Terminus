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
overlay_target="$source_dir/packages/opencode/src/bus/global.ts"
overlay_backup="$(mktemp)"
cp "$overlay_target" "$overlay_backup"
cleanup() {
  cp "$overlay_backup" "$overlay_target"
  rm -f "$overlay_backup"
  find "$source_dir" -name "package.json.bak" | while read -r f; do
    mv "$f" "${f%.bak}"
  done
  find "$source_dir" -name "*.terminus-overlay.bak" -print0 | while IFS= read -r -d '' f; do
    mv "$f" "${f%.terminus-overlay.bak}"
  done
}
trap cleanup EXIT
if [[ -d "$overlay_dir" ]]; then
  while IFS= read -r overlay; do
    python3 "$overlay" "$source_dir"
  done < <(find "$overlay_dir" -type f -name '*.py' | sort)
fi
cd "$source_dir"
bun install --frozen-lockfile --ignore-scripts || {
  echo "[opencode-parity] dependency install reported optional-package failures; continuing to the typecheck" >&2
}
find "$source_dir" -name "package.json" -not -path "*/node_modules/*" | while read -r f; do
  python3 -c '
import sys, json
p = sys.argv[1]
with open(p, "r") as f:
    d = json.load(f)
scripts = d.get("scripts", {})
changed = False
for k, v in list(scripts.items()):
    if "tsgo" in v:
        scripts[k] = v.replace("tsgo", "tsc")
        changed = True
if changed:
    with open(p + ".bak", "w") as f:
        json.dump(d, f, indent=2)
    with open(p, "w") as f:
        json.dump(d, f, indent=2)
' "$f"
done
bun turbo typecheck --force
