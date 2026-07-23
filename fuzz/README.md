# Terminus fuzz targets (M12)

LibFuzzer targets for decoder and policy surfaces that must never panic on
adversarial input (SPEC §46.4, §46.10 nightly corpus).

## Install

```bash
rustup component add llvm-tools-preview
cargo install cargo-fuzz
```

Requires a nightly toolchain for `cargo fuzz` (libfuzzer-sys).

## Run a target

From the repository root:

```bash
cargo fuzz run command_ast --fuzz-dir fuzz
cargo fuzz run unified_diff --fuzz-dir fuzz
cargo fuzz run policy --fuzz-dir fuzz
```

Seed corpora live under `fuzz/corpus/<target>/`. Add regression seeds when a
crash is minimized; do not commit raw crash artifacts that contain secrets.

## Targets

| Target | Surface |
|---|---|
| `command_ast` | `ShellAst::parse` (UTF-8 lossy) |
| `path_symlink` | `SafePath::new` (UTF-8 lossy) |
| `patch_anchors` | InsertContent-like JSON (`serde_json::Value`) |
| `unified_diff` | `terminus_patch::parse_unified_diff` |
| `protobuf_public` | Public JSON decoder smoke |
| `mcp_tool_schemas` | MCP tool-schema JSON |
| `provider_projection` | Provider projection JSON |
| `context_manifests` | Context-manifest JSON |
| `policy` | `PolicyEngine::from_yaml` |
| `redaction_parsers` | `Redactor` with fixed literal pattern |
| `archive_notebook` | Archive/notebook magic + JSON decode smoke |

## CI / release gate

Corpus and property regressions for the gated crates run via:

```bash
just fuzz-smoke
# or
./scripts/run-fuzz-smoke.sh
```

`fuzz-smoke` does **not** run long libfuzzer campaigns; it exercises property
tests and writes `artifacts/release-gate/fuzz-smoke.json`. Full fuzz campaigns
belong on the dedicated nightly Linux runner (SPEC §46.10).
