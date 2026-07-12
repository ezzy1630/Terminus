#!/bin/bash
# Start Terminus mini-services (kernel + control plane) in fully detached
# subshells that survive shell exits. Parent PID becomes 1.
set -e
LOGDIR=/tmp/terminus
mkdir -p "$LOGDIR"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pkill -f "terminus-kernel-mini" 2>/dev/null || true
pkill -f "bun.*mini-services/terminus-control" 2>/dev/null || true
sleep 1

# TERMINUS_DEV=1 permits the well-known dev tokens for local development
# (SPEC §13.6). The control plane fails closed without a token otherwise.
export TERMINUS_DEV=1
export TERMINUS_KERNEL_TOKEN="${TERMINUS_KERNEL_TOKEN:-terminus-kernel-dev-token}"
export TERMINUS_CONTROL_TOKEN="${TERMINUS_CONTROL_TOKEN:-terminus-control-dev-token}"
export TERMINUS_KERNEL_CAPABILITY_SECRET="${TERMINUS_KERNEL_CAPABILITY_SECRET:-terminus-kernel-dev-capability-secret-please-rotate}"
export DATABASE_URL="${DATABASE_URL:-file:$HOME/.local/share/terminus/terminus.db}"

cd "$ROOT/mini-services/terminus-kernel"
. "$HOME/.cargo/env" 2>/dev/null || true
TERMINUS_DATA="$ROOT/.terminus-data" \
setsid ./target/release/terminus-kernel-mini </dev/null >"$LOGDIR/kernel.log" 2>&1 &
echo "kernel started, log: $LOGDIR/kernel.log"

sleep 1

cd "$ROOT"
( setsid bash -c "cd \"$ROOT\" && exec bun mini-services/terminus-control/src/index.ts" </dev/null >"$LOGDIR/control.log" 2>&1 & disown ) &
echo "control started, log: $LOGDIR/control.log"

sleep 3
echo "--- kernel health ---"
curl -sS http://127.0.0.1:3040/v1/health -X POST -H "Authorization: Bearer $TERMINUS_KERNEL_TOKEN" -d '{}' 2>&1 | head -c 200
echo
echo "--- control health ---"
curl -sS http://127.0.0.1:3050/v1/system/health -H "Authorization: Bearer $TERMINUS_CONTROL_TOKEN" 2>&1 | head -c 200
echo
