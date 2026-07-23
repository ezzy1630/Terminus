#!/usr/bin/env bash
# Local SBOM verify for release gate (SPEC §46.14).
# Prefer syft; fall back to a deterministic SPDX stub from workspace members.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_DIR="$ROOT/artifacts/release-gate"
mkdir -p "$OUT_DIR"
OUT_JSON="$OUT_DIR/sbom-verify.json"
SBOM_OUT="$OUT_DIR/sbom-cargo.spdx.json"
generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

write_fallback_spdx() {
  python3 - <<'PY'
import json, pathlib, datetime, hashlib, re
root = pathlib.Path(".")
members = []
text = (root / "Cargo.toml").read_text()
# workspace members = ["crates/*"] — expand crates/*
for p in sorted((root / "crates").glob("*/Cargo.toml")):
    name = None
    for line in p.read_text().splitlines():
        m = re.match(r'name\s*=\s*"([^"]+)"', line)
        if m:
            name = m.group(1)
            break
    if name:
        members.append(name)
doc = {
    "spdxVersion": "SPDX-2.3",
    "dataLicense": "CC0-1.0",
    "SPDXID": "SPDXRef-DOCUMENT",
    "name": "terminus-workspace-fallback",
    "documentNamespace": "https://terminus.local/spdx/fallback/" + hashlib.sha256(",".join(members).encode()).hexdigest()[:16],
    "creationInfo": {
        "created": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "creators": ["Tool: terminus-verify-sbom-local"],
    },
    "packages": [
        {
            "SPDXID": f"SPDXRef-Package-{i}",
            "name": name,
            "downloadLocation": "NOASSERTION",
            "filesAnalyzed": False,
        }
        for i, name in enumerate(members)
    ],
}
out = root / "artifacts" / "release-gate" / "sbom-cargo.spdx.json"
out.write_text(json.dumps(doc, indent=2) + "\n")
print(len(members))
PY
}

if command -v syft >/dev/null 2>&1; then
  syft "Cargo.toml" -o spdx-json >"$SBOM_OUT"
  tool="syft"
  status="passed"
else
  count="$(write_fallback_spdx)"
  tool="terminus-fallback-spdx"
  status="passed_fallback"
  echo "[sbom-verify] syft missing; wrote fallback SPDX for $count workspace crates"
fi

if [[ ! -s "$SBOM_OUT" ]]; then
  cat >"$OUT_JSON" <<EOF
{
  "status": "failed",
  "generatedAt": "$generated_at",
  "tool": "$tool",
  "reason": "SBOM output empty"
}
EOF
  echo "[sbom-verify] status=failed (empty SBOM)"
  exit 1
fi

bytes=$(wc -c <"$SBOM_OUT" | tr -d ' ')
cat >"$OUT_JSON" <<EOF
{
  "status": "$status",
  "generatedAt": "$generated_at",
  "tool": "$tool",
  "sbomPath": "artifacts/release-gate/sbom-cargo.spdx.json",
  "bytes": $bytes
}
EOF

echo "[sbom-verify] status=$status → $OUT_JSON"
