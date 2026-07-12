#!/usr/bin/env bash
# Deterministic lifecycle harness. The shell supervisor owns the two local
# services; the assertion runner only speaks the public control-plane API.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/terminus-e2e.XXXXXX")"
KERNEL_PID=""
CONTROL_PID=""

cleanup() {
  status=$?
  set +e
  trap - EXIT
  if [[ -n "$CONTROL_PID" ]]; then
    kill "$CONTROL_PID" 2>/dev/null
    wait "$CONTROL_PID" 2>/dev/null
  fi
  if [[ -n "$KERNEL_PID" ]]; then
    kill "$KERNEL_PID" 2>/dev/null
    wait "$KERNEL_PID" 2>/dev/null
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "[e2e] failed; diagnostic bundle preserved at $TMP_DIR" >&2
  else
    rm -rf "$TMP_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

export TERMINUS_DEV=1
export RUST_LOG=info
export TERMINUS_KERNEL_TOKEN="terminus-kernel-e2e-token"
export TERMINUS_CONTROL_TOKEN="terminus-control-e2e-token"
export TERMINUS_KERNEL_CAPABILITY_SECRET="terminus-kernel-e2e-capability-secret"
export TERMINUS_DATA="$TMP_DIR/kernel-data"
export TERMINUS_KERNEL_CAP_TOKEN_FILE="$TMP_DIR/capability.token"
export DATABASE_URL="file:$TMP_DIR/control.db"
export TERMINUS_E2E_WORKSPACE_ROOT="$TMP_DIR/workspace"
mkdir -p "$TERMINUS_E2E_WORKSPACE_ROOT"

if curl -sS --max-time 1 http://127.0.0.1:3040/v1/health -X POST >/dev/null 2>&1; then
  echo "[e2e] port 3040 is already in use; refusing to share a privileged kernel" >&2
  exit 1
fi
if curl -sS --max-time 1 http://127.0.0.1:3050/v1/system/health >/dev/null 2>&1; then
  echo "[e2e] port 3050 is already in use; refusing to share a control plane" >&2
  exit 1
fi

echo "[e2e] preparing isolated SQLite database"
DATABASE_URL="$DATABASE_URL" bun run "$ROOT/scripts/migrate.ts" >"$TMP_DIR/migrate.log" 2>&1

echo "[e2e] starting kernel"
kernel_binary="$ROOT/mini-services/terminus-kernel/target/debug/terminus-kernel-mini"
if [[ ! -x "$kernel_binary" ]]; then
  cargo build --manifest-path "$ROOT/mini-services/terminus-kernel/Cargo.toml" >"$TMP_DIR/kernel-build.log" 2>&1
fi
nohup "$kernel_binary" </dev/null >"$TMP_DIR/kernel.log" 2>&1 &
KERNEL_PID=$!

for _ in $(seq 1 600); do
  if curl -fsS --max-time 1 http://127.0.0.1:3040/v1/health \
    -X POST -H "Authorization: Bearer $TERMINUS_KERNEL_TOKEN" -d '{}' >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! curl -fsS --max-time 1 http://127.0.0.1:3040/v1/health \
  -X POST -H "Authorization: Bearer $TERMINUS_KERNEL_TOKEN" -d '{}' >/dev/null; then
  echo "[e2e] kernel did not become healthy; see $TMP_DIR/kernel.log" >&2
  exit 1
fi

capability_token=""
for _ in $(seq 1 600); do
  if [[ -f "$TERMINUS_KERNEL_CAP_TOKEN_FILE" ]]; then
    capability_token="$(<"$TERMINUS_KERNEL_CAP_TOKEN_FILE")"
  fi
  if [[ -n "$capability_token" ]]; then break; fi
  sleep 0.1
done
if [[ -z "$capability_token" ]]; then
  echo "[e2e] kernel did not publish a development capability for the isolated harness" >&2
  exit 1
fi
export TERMINUS_KERNEL_CAP_TOKEN="$capability_token"

echo "[e2e] starting control plane"
nohup bun run "$ROOT/mini-services/terminus-control/src/index.ts" </dev/null >"$TMP_DIR/control.log" 2>&1 &
CONTROL_PID=$!

for _ in $(seq 1 600); do
  if curl -fsS --max-time 1 http://127.0.0.1:3050/v1/system/health \
    -H "Authorization: Bearer $TERMINUS_CONTROL_TOKEN" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! curl -fsS --max-time 1 http://127.0.0.1:3050/v1/system/health \
  -H "Authorization: Bearer $TERMINUS_CONTROL_TOKEN" >/dev/null; then
  echo "[e2e] control plane did not become healthy; see $TMP_DIR/control.log" >&2
  exit 1
fi

TERMINUS_E2E_CONTROL_URL="http://127.0.0.1:3050" \
  TERMINUS_E2E_CONTROL_TOKEN="$TERMINUS_CONTROL_TOKEN" \
  bun run "$ROOT/scripts/e2e/assert-lifecycle.ts"
