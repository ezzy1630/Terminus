# Terminus root task runner (SPEC §43.7, §43.8, §45.3).
# User-facing commands. Individual package commands remain available via
# cargo/pnpm/bun/uv directly.

set shell := ["bash", "-eu", "-c"]
export TERMINUS_ROOT := justfile_directory()
export CARGO_TARGET_DIR := justfile_directory() / "target"
export RUST_BACKTRACE := "1"

# Default: list available recipes.
default:
    @just --list

# Install pinned tools/dependencies and verify environment.
bootstrap:
    #!/usr/bin/env bash
    set -eu
    echo "[bootstrap] verifying mise tools..."
    mise --version
    mise install -y
    echo "[bootstrap] verifying Rust toolchain..."
    cargo --version
    rustc --version
    # mise-managed toolchains do not always ship default components; the
    # lint gates below require rustfmt and clippy. No-op where present.
    if command -v rustup >/dev/null 2>&1; then
      rustup component add rustfmt clippy
    fi
    echo "[bootstrap] installing Rust workspace deps..."
    cargo fetch
    echo "[bootstrap] installing TS workspace deps..."
    bun install --frozen-lockfile
    echo "[bootstrap] installing Python eval deps..."
    (cd python && uv sync --frozen --extra dev)
    echo "[bootstrap] verifying buf..."
    buf --version
    echo "[bootstrap] verifying OpenCode source pin..."
    bash scripts/fetch-opencode.sh
    echo "[bootstrap] OK"

# Build Rust, TypeScript, and generated contracts.
build:
    cargo build --workspace --all-targets
    # SPEC §42: build (typecheck) the canonical Terminus TS packages, then the
    # Next.js dashboard. The kernel mini-service builds via its own crate.
    bun run build:packages
    bun run build
    cd python && uv run build

# Fast lint/type/unit checks.
check: boundary-check
    cargo fmt --all -- --check
    # Rely on [workspace.lints] (SPEC §44.2): clippy::all, unwrap/expect/panic,
    # unsafe_code, and unused_must_use are denied at the Cargo.toml level;
    # pedantic/nursery are advisory (warn) and must NOT be escalated to errors.
    cargo clippy --workspace --all-targets
    bun run lint
    # SPEC §44.3: typecheck the canonical Terminus packages under strict
    # settings (tsconfig.packages.json), then the Next.js dashboard.
    bun run typecheck:packages
    bun run typecheck
    cd python && uv run --extra dev ruff check . && uv run --extra dev mypy forge_evals

# Lint + test the kernel HTTP mini-service, which intentionally sits outside
# the root Cargo workspace (SPEC §42.5 boundary). The root `cargo clippy
# --workspace` does not cover it, so it is checked explicitly here and in CI.
kernel-mini-check:
    #!/usr/bin/env bash
    set -eu
    cd mini-services/terminus-kernel
    cargo fmt -- --check
    cargo clippy --all-targets
    cargo test

# Architecture boundary checks (SPEC §42.5).
boundary-check:
    bun run tools/boundary-check.ts

# Full local validation.
check-all: check kernel-mini-check codegen-check truth-check unit integration security

# Regenerate all derived contracts.
codegen: codegen-proto codegen-public-api codegen-events codegen-tools codegen-config codegen-v2-schemas codegen-sqlx codegen-docs

# Verify no generated drift.
codegen-check:
    #!/usr/bin/env bash
    set -eu
    just codegen
    if ! git diff --exit-code -- 'packages/**/generated*/**' 'crates/**/generated/**' 'schemas/generated/**' 'docs/generated/**'; then
      echo "[codegen-check] generated drift detected; run 'just codegen' and commit" >&2
      exit 1
    fi

# Protobuf codegen (Rust types via prost, TS clients via buf).
codegen-proto:
    buf generate proto
    mkdir -p schemas/generated
    buf build proto --as-file-descriptor-set --exclude-source-info -o schemas/generated/terminus.kernel.v1.binpb

# Read-only Linux host preflight for the real enforcement runner.
linux-enforcement-prereqs:
    bash scripts/verify-linux-enforcement-prereqs.sh

# Produce signed evidence only from a Linux runner that publishes an effective
# enforcement report; the producer fails closed when that proof is absent.
linux-enforcement-evidence:
    bash scripts/produce-linux-enforcement-evidence.sh

# Public API codegen (OpenAPI → TS/Rust/Python clients).
codegen-public-api:
    bun run tools/codegen/public-api.ts

# Event catalog codegen (TS/Rust types, JSON schemas, docs, fixtures).
codegen-events:
    bun run tools/codegen/events.ts

# Tool schema codegen (provider dialects, validators, docs).
codegen-tools:
    bun run tools/codegen/tools.ts

# Config codegen (JSON Schema, docs, sample config).
codegen-config:
    bun run tools/codegen/config.ts

# ARP v2 canonical schema registry (JSON Schema 2020-12 + registry manifest).
codegen-v2-schemas:
    bun run tools/codegen/v2-schemas.ts

# SQLx offline query metadata.
codegen-sqlx:
    bun run tools/codegen/sqlx.ts

# Generated docs (ADR index, event catalog markdown, API docs).
codegen-docs:
    bun run tools/codegen/docs.ts

# All unit tests.
unit:
    cargo test --workspace --lib
    bun run test:unit
    cd python && uv run --extra dev pytest -q

# Integration tests.
integration:
    cargo test --workspace --test '*'
    bun run test:integration
    cd python && uv run --extra dev pytest -q forge_evals/forge_evals/tests/test_runner_grader_integration.py

# Local-capable security suite (per-PR subset).
security:
    cargo test --workspace --test capability_token_e2e --test non_bypassability --test policy_wiring
    bun run test:security
    cargo deny check

# End-to-end task tests.
e2e:
    bun run test:e2e

# Small deterministic eval suite.
eval-smoke:
    #!/usr/bin/env bash
    set -eu
    cd python
    for task in build-failure/build-001 test-generation/testgen-001; do
      uv run terminus-eval run --suite terminus-internal --task "$task" --task-dir "forge_evals/evals/tasks/$task" --harness terminus-minimal --seeds 1 --output-dir evals/results/smoke
    done

# Full configured evaluation suite.
eval-full:
    #!/usr/bin/env bash
    set -eu
    cd python
    for task_dir in forge_evals/evals/tasks/*/*; do
      test -d "$task_dir" || continue
      task="${task_dir#forge_evals/evals/tasks/}"
      uv run terminus-eval run --suite terminus-internal --task "$task" --task-dir "$task_dir" --harness terminus-minimal --seeds 3 --output-dir evals/results/full
    done

# OpenCode parity and divergence checks.
upstream-check:
    #!/usr/bin/env bash
    set -eu
    # The divergence verifier needs pyyaml; run under the pinned python env
    # so the dependency comes from the locked uv environment, not the host.
    uv run --project python python scripts/verify-upstream-divergence.py
    bun test packages/open-code-bridge
    bash scripts/verify-opencode-parity.sh


# Property + fuzz-smoke corpus regressions (SPEC §46.3 / §46.4).
fuzz-smoke:
    bash scripts/run-fuzz-smoke.sh

# Full fault-injection matrix (SPEC §46.9).
fault-injection:
    bun run scripts/run-fault-injection.ts

# Migration / backup / restore / rollback / clean-install drills (SPEC §46.17).
release-drills:
    #!/usr/bin/env bash
    set -eu
    bun test tests/release/
    bun -e '
      const { mkdirSync, writeFileSync } = require("node:fs");
      mkdirSync("artifacts/release-gate", { recursive: true });
      writeFileSync("artifacts/release-gate/upgrade-rollback.json", JSON.stringify({
        status: "passed",
        generatedAt: new Date().toISOString(),
        suites: ["upgrade_rollback_drill", "backup_restore_drill", "clean_install_upgrade_downgrade"],
      }, null, 2) + "\n");
    '

# Short soak/leak (set TERMINUS_SOAK_SECONDS=86400 for full 24h).
soak:
    bash scripts/soak-leak-test.sh

# Preview canary + ops metrics.
canary:
    bash scripts/preview-canary.sh
    bun run scripts/collect-ops-metrics.ts

# Release eval tier evidence.
eval-release:
    bash scripts/run-release-evals.sh

# SBOM + schema freeze evidence (local).
sbom-verify:
    bash scripts/verify-sbom-local.sh

schema-freeze-evidence:
    bun run scripts/write-schema-freeze-evidence.ts

# Four-owner machine-readable release decision (SPEC §50.10).
release-decision: platform-matrix
    bun run scripts/produce-release-decision.ts

# Evidence-derived platform/backend support matrix (roadmap Phase 0). A
# platform is "supported" only with conformance evidence bound to HEAD.
platform-matrix:
    bun run scripts/produce-platform-matrix.ts

# Cross-check source declarations against release metadata and CI config.
truth-check:
    bun run scripts/check-declaration-consistency.ts

# First system card: maturity, platform support, limitations, missing infra.
system-card:
    bun run scripts/produce-system-card.ts

# Signed baseline evaluation evidence bound to HEAD (roadmap Phase 0).
eval-baseline:
    bash scripts/run-eval-baseline.sh

# Aggregate M12 exit-gate evidence report.
m12-exit-gate: fuzz-smoke fault-injection release-drills soak canary eval-release sbom-verify schema-freeze-evidence release-decision system-card
    bun run scripts/m12-exit-gate.ts

# Release gate (SPEC §46.18, §50). Every dependency is mandatory; missing
# infrastructure or evidence is a release failure, not a warning.
release-check: check-all e2e eval-smoke upstream-check m12-exit-gate
    #!/usr/bin/env bash
    set -eu
    if [[ -n "${TERMINUS_LINUX_EVIDENCE:-}" ]]; then
      bash scripts/verify-release-evidence.sh
    else
      echo "[release-check] Linux enforcement evidence requires CI (TERMINUS_LINUX_EVIDENCE unset)" >&2
      echo "[release-check] local m12 evidence produced under artifacts/release-gate/" >&2
      # Fail closed for stable release; preview may set TERMINUS_RELEASE_ALLOW_MISSING_LINUX=1
      if [[ "${TERMINUS_RELEASE_ALLOW_MISSING_LINUX:-}" != "1" ]]; then
        exit 1
      fi
    fi
    echo "[release-check] PASS — required local checks and release evidence are present"

# Run control plane and kernel locally (supervised).
run:
    #!/usr/bin/env bash
    set -eu
    echo "[run] starting kernel (:3040), control (:3050), tui (:3000) — Ctrl-C to stop"
    trap 'kill 0' EXIT INT TERM
    (just run-kernel) &
    (just run-control) &
    (just run-tui) &
    wait

# Run the Rust kernel mini-service on :3040.
run-kernel:
    cd mini-services/terminus-kernel && TERMINUS_DEV=1 TERMINUS_KERNEL_HTTP_BOOTSTRAP=1 cargo run --release

# Run the TS control plane mini-service on :3050.
run-control:
    cd mini-services/terminus-control && bun run dev

# Run the Next.js dashboard on :3000.
run-tui:
    bun run dev

# Scaffolding helpers (SPEC §45.7).
new-ts-package name:
    bun run tools/scaffold/new-ts-package.ts {{name}}

new-rust-crate name:
    bun run tools/scaffold/new-rust-crate.ts {{name}}

new-tool id:
    bun run tools/scaffold/new-tool.ts {{id}}

new-event type:
    bun run tools/scaffold/new-event.ts {{type}}

new-capability id:
    bun run tools/scaffold/new-capability.ts {{id}}

new-adapter id:
    bun run tools/scaffold/new-adapter.ts {{id}}

new-eval suite task:
    bun run tools/scaffold/new-eval.ts {{suite}} {{task}}

new-adr title:
    bun run tools/scaffold/new-adr.ts "{{title}}"
