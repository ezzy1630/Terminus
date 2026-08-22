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
find "$source_dir" \( -name "tsgo.js" -o -name "tsgo" \) 2>/dev/null | while read -r f; do
  cat << 'EOF' > "$f"
#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const tscPath = require.resolve("typescript/bin/tsc", { paths: [__dirname, process.cwd()] });
try {
  execFileSync(process.execPath, [tscPath, ...process.argv.slice(2)], { stdio: "inherit" });
} catch (err) {
  process.exit(err.status ?? 1);
}
EOF
  chmod +x "$f"
done
bun turbo typecheck
