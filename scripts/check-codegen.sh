#!/usr/bin/env bash
set -eu

generated_paths=(
  'packages/**/generated*/**'
  'crates/**/generated/**'
  'schemas/generated/**'
  'docs/generated/**'
)
artifact_dir="artifacts/codegen"

generated_manifest() {
  {
    find packages -type f -path '*/generated*/*' -print 2>/dev/null
    find crates -type f -path '*/generated/*' -print 2>/dev/null
    find schemas/generated docs/generated -type f -print 2>/dev/null
  } | LC_ALL=C sort | while IFS= read -r path; do
    shasum -a 256 "$path"
  done
}

report_drift() {
  mkdir -p "$artifact_dir"
  git status --short --untracked-files=all -- "${generated_paths[@]}" \
    | tee "$artifact_dir/generated-files.txt" >&2
  git diff --binary HEAD -- "${generated_paths[@]}" \
    > "$artifact_dir/generated-drift.patch"
  git diff HEAD -- "${generated_paths[@]}" >&2
  echo "[codegen-check] generated drift detected; run 'just codegen' and commit the listed files" >&2
}

has_generated_drift() {
  ! git diff --quiet HEAD -- "${generated_paths[@]}" ||
    [ -n "$(git ls-files --others --exclude-standard -- "${generated_paths[@]}")" ]
}

just codegen
first_manifest="$(generated_manifest)"

# A second run must be byte-identical to the first. This detects generators
# that embed clocks, host paths, unstable iteration order, or line endings.
just codegen
second_manifest="$(generated_manifest)"
if [ "$first_manifest" != "$second_manifest" ]; then
  mkdir -p "$artifact_dir"
  printf '%s\n' "$first_manifest" > "$artifact_dir/first-manifest.sha256"
  printf '%s\n' "$second_manifest" > "$artifact_dir/second-manifest.sha256"
  echo "[codegen-check] a second generation pass was not byte-identical" >&2
  diff -u "$artifact_dir/first-manifest.sha256" "$artifact_dir/second-manifest.sha256" >&2 || true
  exit 1
fi

if has_generated_drift; then
  report_drift
  exit 1
fi

echo "[codegen-check] deterministic and current"
