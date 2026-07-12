# Forge root task runner (SPEC §43.7, §43.8, §45.3).
# User-facing commands. Individual package commands remain available via
# cargo/pnpm/bun/uv directly.

set -eu
shell := ["bash", "-c"]
export FORGE_ROOT := justfile_directory()
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
    echo "[bootstrap] installing Rust workspace deps..."
    cargo fetch
    echo "[bootstrap] installing TS workspace deps..."
    bun install --frozen-lockfile
    echo "[bootstrap] installing Python eval deps..."
    cd python && uv sync --frozen || uv sync
    echo "[bootstrap] verifying buf..."
    buf --version
    echo "[bootstrap] OK"

# Build Rust, TypeScript, and generated contracts.
build:
    cargo build --workspace --all-targets
    bun run build
    cd python && uv run build || true

# Fast lint/type/unit checks.
check:
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    bun run lint
    bun run typecheck
    cd python && uv run ruff check . && uv run mypy forge_evals || true

# Full local validation.
check-all: check codegen-check unit integration security

# Regenerate all derived contracts.
codegen: codegen-proto codegen-public-api codegen-events codegen-tools codegen-config codegen-sqlx codegen-docs

# Verify no generated drift.
codegen-check:
    #!/usr/bin/env bash
    set -eu
    just codegen
    if ! git diff --exit-code -- 'packages/**/generated/**' 'crates/**/generated/**' 'schemas/generated/**' 'docs/generated/**'; then
      echo "[codegen-check] generated drift detected; run 'just codegen' and commit" >&2
      exit 1
    fi

# Protobuf codegen (Rust types via prost, TS clients via buf).
codegen-proto:
    buf generate proto

# Public API codegen (OpenAPI → TS/Rust/Python clients).
codegen-public-api:
    echo "[codegen-public-api] TODO: generate OpenAPI clients from packages/public-api"

# Event catalog codegen (TS/Rust types, JSON schemas, docs, fixtures).
codegen-events:
    echo "[codegen-events] TODO: generate event types from schemas/events/catalog.yaml"

# Tool schema codegen (provider dialects, validators, docs).
codegen-tools:
    echo "[codegen-tools] TODO: generate tool schemas from schemas/tools/*.json"

# Config codegen (JSON Schema, docs, sample config).
codegen-config:
    echo "[codegen-config] TODO: generate config schemas"

# SQLx offline query metadata.
codegen-sqlx:
    echo "[codegen-sqlx] TODO: generate SQLx offline metadata from migrations/sqlite/"

# Generated docs (ADR index, event catalog markdown, API docs).
codegen-docs:
    echo "[codegen-docs] TODO: generate docs index"

# All unit tests.
unit:
    cargo test --workspace --lib
    bun run test:unit
    cd python && uv run pytest -q

# Integration tests.
integration:
    cargo test --workspace --test '*'
    bun run test:integration || true
    cd python && uv run pytest -q tests/integration || true

# Local-capable security suite (per-PR subset).
security:
    cargo test --workspace --test security
    bun run test:security || true
    cargo deny check || true

# End-to-end task tests.
e2e:
    bun run test:e2e || true
    echo "[e2e] TODO: drive full session/task/event/approval/resume cycle"

# Small deterministic eval suite.
eval-smoke:
    cd python && uv run forge-eval run --suite forge-internal --tasks tiny-bugfix/01-fix-typo,tiny-bugfix/02-null-check --runs 1

# Full configured evaluation suite.
eval-full:
    cd python && uv run forge-eval run --suite forge-internal --runs 3
    cd python && uv run forge-eval run --suite swe-bench-verified --runs 3
    cd python && uv run forge-eval run --suite terminal-bench --runs 3

# OpenCode parity and divergence checks.
upstream-check:
    #!/usr/bin/env bash
    set -eu
    echo "[upstream-check] verifying pinned OpenCode commit..."
    test -f upstream/opencode.lock.json
    echo "[upstream-check] divergence budget:"
    cat upstream/divergence-budget.yaml
    echo "[upstream-check] TODO: run parity test suite against pinned upstream commit"

# Release gate (SPEC §46.18, §50).
release-check: check-all e2e eval-smoke
    echo "[release-check] TODO: full release gate per SPEC §46.18"

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
    cd mini-services/forge-kernel && cargo run --release

# Run the TS control plane mini-service on :3050.
run-control:
    cd mini-services/forge-control && bun run dev

# Run the Next.js dashboard on :3000.
run-tui:
    bun run dev

# Scaffolding helpers (SPEC §45.7).
new-ts-package name:
    echo "[new-ts-package] TODO: scaffold packages/{{name}} with README, AGENTS, tests, lint"

new-rust-crate name:
    echo "[new-rust-crate] TODO: scaffold crates/{{name}} with Cargo.toml, lib.rs, AGENTS"

new-tool id:
    echo "[new-tool] TODO: scaffold schemas/tools/{{id}}.json and codegen"

new-event type:
    echo "[new-event] TODO: add {{type}} to schemas/events/catalog.yaml and codegen"

new-capability id:
    echo "[new-capability] TODO: scaffold capability descriptor"

new-adapter id:
    echo "[new-adapter] TODO: scaffold adapters/{{id}} with adapter.yaml and README"

new-eval suite task:
    echo "[new-eval] TODO: scaffold evals/tasks/{{suite}}/{{task}} with task.yaml, prompt.md, grader/"

new-adr title:
    #!/usr/bin/env bash
    set -eu
    next=$(ls docs/decisions/ADR-*.md 2>/dev/null | sort -V | tail -1 | sed 's/.*ADR-//;s/-.*//' || echo 0)
    next=$(printf "%04d" $((10#${next} + 1)))
    path="docs/decisions/ADR-${next}-{{title}}.md"
    cat > "$path" <<'EOF'
# ADR-{next}: {title}

- **Status:** PROPOSED
- **Date:** $(date +%Y-%m-%d)
- **Decision owner:** (name)

## Context

## Decision

## Alternatives

## Consequences

## Security Impact

## Evaluation Plan

## Migration

## Rollback
EOF
    echo "[new-adr] created $path"
