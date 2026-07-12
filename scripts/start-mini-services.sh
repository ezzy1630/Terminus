#!/bin/bash
# Start Forge mini-services (kernel + control plane) in fully detached
# subshells that survive shell exits. Parent PID becomes 1.
set -e
LOGDIR=/tmp/forge
mkdir -p "$LOGDIR"
pkill -f "forge-kernel-mini" 2>/dev/null || true
pkill -f "bun.*mini-services/forge-control" 2>/dev/null || true
sleep 1

cd /home/z/my-project/mini-services/forge-kernel
. "$HOME/.cargo/env"
FORGE_DATA=/home/z/my-project/.forge-data \
FORGE_KERNEL_TOKEN=forge-kernel-dev-token \
setsid ./target/release/forge-kernel-mini </dev/null >"$LOGDIR/kernel.log" 2>&1 &
echo "kernel started, log: $LOGDIR/kernel.log"

sleep 1

cd /home/z/my-project
( setsid bash -c 'cd /home/z/my-project && exec bun mini-services/forge-control/src/index.ts' </dev/null >"$LOGDIR/control.log" 2>&1 & disown ) &
echo "control started, log: $LOGDIR/control.log"

sleep 3
echo "--- kernel health ---"
curl -sS http://127.0.0.1:3040/v1/health -X POST -H "Authorization: Bearer forge-kernel-dev-token" -d '{}' 2>&1 | head -c 200
echo
echo "--- control health ---"
curl -sS http://127.0.0.1:3050/v1/system/health 2>&1 | head -c 200
echo
