#!/bin/bash
# Start Next.js dev server in a fully detached subshell that survives shell exits.
# Uses webpack (not Turbopack) to reduce memory pressure on small hosts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${TERMINUS_NEXT_LOG:-/tmp/terminus-next.log}"

pkill -f "next dev" 2>/dev/null || true
pkill -f "next-server (v|running)" 2>/dev/null || true
sleep 1
(
  setsid bash -c "cd '$ROOT' && exec node node_modules/.bin/next dev -p 3000 --webpack" \
    </dev/null >"$LOG" 2>&1 &
  disown
) &
echo "next dev started, log: $LOG"
sleep 3
ps -ef | grep -E "next dev|next-server" | grep -v grep || true
