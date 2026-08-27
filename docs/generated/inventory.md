# Static inventory

> Auto-generated from the source tree by `tools/codegen/inventory.ts`.
> Do not edit by hand — run `just codegen`.

**Honesty boundary:** every count below is a STATIC source scan at HEAD.
A declared test is not a passing run. Executed-test evidence lives in CI
(workflow artifacts on the exact commit) and under `artifacts/release-gate/`.

| Fact | Value | How derived |
|---|---:|---|
| SPEC.md lines | 9647 | wc of SPEC.md |
| Rust crates | 23 | directories in crates/ |
| TypeScript packages | 37 | directories in packages/ |
| Client apps | 4 | directories in apps/ |
| External harness adapters | 7 | directories in adapters/ |
| Mini-services | 2 | directories in mini-services/ |
| Declared Rust tests | 443 | `#[test]` + `#[tokio::test]` occurrences in crates/** (excl. generated) |
| TypeScript test files | 119 | `*.test.{ts,tsx}` in packages/ + apps/ |
| Declared TypeScript test blocks | 940 | `test(/it(` occurrences in those files |
| Declared Python tests | 268 | `def test_*` in python/** |
| ADRs | 51 | docs/decisions/ADR-*.md |
| Runbooks | 15 | docs/runbooks/*.md |
| SQLite migrations | 12 | migrations/sqlite/*.sql |

Maturity classification of every component: see the
[component maturity registry](component-maturity.md) (`maturity.yaml`).
