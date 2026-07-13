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
export TERMINUS_KERNEL_GRPC_SOCKET="$TMP_DIR/kernel.sock"
export TERMINUS_KERNEL_REQUIRE_UDS=1
export DATABASE_URL="file:$TMP_DIR/control.db"
export TERMINUS_E2E_WORKSPACE_ROOT="$TMP_DIR/workspace"
KERNEL_PORT="${TERMINUS_E2E_KERNEL_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')}"
CONTROL_PORT="${TERMINUS_E2E_CONTROL_PORT:-$((KERNEL_PORT + 1))}"
export TERMINUS_KERNEL_PORT="$KERNEL_PORT"
export TERMINUS_CONTROL_PORT="$CONTROL_PORT"
mkdir -p "$TERMINUS_E2E_WORKSPACE_ROOT"
mkdir -p "$TERMINUS_DATA"
cp "$ROOT/scripts/e2e/fixtures/read.txt" "$TERMINUS_DATA/e2e-fixture.txt"

if curl --noproxy '*' -sS --max-time 1 "http://127.0.0.1:$CONTROL_PORT/v1/system/health" >/dev/null 2>&1; then
  echo "[e2e] port $CONTROL_PORT is already in use; refusing to share a control plane" >&2
  exit 1
fi

echo "[e2e] preparing isolated SQLite database"
DATABASE_URL="$DATABASE_URL" bun run "$ROOT/scripts/migrate.ts" >"$TMP_DIR/migrate.log" 2>&1

echo "[e2e] starting kernel"
kernel_binary="$ROOT/mini-services/terminus-kernel/target/debug/terminus-kernel-mini"
cargo build --manifest-path "$ROOT/mini-services/terminus-kernel/Cargo.toml" >"$TMP_DIR/kernel-build.log" 2>&1
if [[ ! -x "$kernel_binary" ]]; then
  echo "[e2e] kernel build did not produce an executable; see $TMP_DIR/kernel-build.log" >&2
  exit 1
fi
# macOS dyld can hold an executable on the external Neural volume in the
# loader before main() starts. Copy the verified build into the isolated
# temporary run directory so startup is independent of the source volume.
kernel_runtime="$TMP_DIR/terminus-kernel-mini"
cp "$kernel_binary" "$kernel_runtime"
chmod 700 "$kernel_runtime"
nohup "$kernel_runtime" </dev/null >"$TMP_DIR/kernel.log" 2>&1 &
KERNEL_PID=$!

for _ in $(seq 1 600); do
  if [[ -S "$TERMINUS_KERNEL_GRPC_SOCKET" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -S "$TERMINUS_KERNEL_GRPC_SOCKET" ]]; then
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

start_control() {
  echo "[e2e] starting control plane"
  nohup bun run "$ROOT/mini-services/terminus-control/src/index.ts" </dev/null >>"$TMP_DIR/control.log" 2>&1 &
  CONTROL_PID=$!

  for _ in $(seq 1 600); do
    if curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$CONTROL_PORT/v1/system/health" \
      -H "Authorization: Bearer $TERMINUS_CONTROL_TOKEN" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done

  if ! curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$CONTROL_PORT/v1/system/health" \
    -H "Authorization: Bearer $TERMINUS_CONTROL_TOKEN" >/dev/null; then
    echo "[e2e] control plane did not become healthy; see $TMP_DIR/control.log" >&2
    exit 1
  fi
}

start_control

lifecycle_json="$(
  TERMINUS_E2E_CONTROL_URL="http://127.0.0.1:$CONTROL_PORT" \
    TERMINUS_E2E_CONTROL_TOKEN="$TERMINUS_CONTROL_TOKEN" \
    TERMINUS_E2E_DEBUG="${TERMINUS_E2E_DEBUG:-0}" \
    bun run "$ROOT/scripts/e2e/assert-lifecycle.ts"
)"
echo "$lifecycle_json"

json_field() {
  python3 -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

export TERMINUS_E2E_SESSION_ID="$(printf '%s' "$lifecycle_json" | json_field session_id)"
export TERMINUS_E2E_TASK_ID="$(printf '%s' "$lifecycle_json" | json_field task_id)"
export TERMINUS_E2E_THREAD_ID="$(printf '%s' "$lifecycle_json" | json_field thread_id)"
export TERMINUS_E2E_CHECKPOINT_ID="$(printf '%s' "$lifecycle_json" | json_field checkpoint_id)"

echo "[e2e] restarting control plane for recovery/resume proof"
kill "$CONTROL_PID" 2>/dev/null || true
wait "$CONTROL_PID" 2>/dev/null || true
CONTROL_PID=""
start_control

TERMINUS_E2E_CONTROL_URL="http://127.0.0.1:$CONTROL_PORT" \
  TERMINUS_E2E_CONTROL_TOKEN="$TERMINUS_CONTROL_TOKEN" \
  bun run "$ROOT/scripts/e2e/assert-restart.ts"
