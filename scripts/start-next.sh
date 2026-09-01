#!/bin/bash
# Start Next.js dev server in a fully detached subshell that survives shell exits.
# Uses webpack (not Turbopack) to reduce memory pressure on small hosts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${TERMINUS_NEXT_LOG:-$(mktemp -t terminus-next-log.XXXXXX)}"
# mktemp creates the file; the server needs the path, not a pre-created file.
rm -f "$LOG"

# Kill only servers started by this script (the --webpack flag is part of
# every invocation below); a same-flag server in another checkout can still
# match, which is acceptable for a local dev helper.
pkill -f "next dev -p 3000 --webpack" 2>/dev/null || true
sleep 1
(
  setsid bash -c "cd '$ROOT' && exec node node_modules/.bin/next dev -p 3000 --webpack" \
    </dev/null >"$LOG" 2>&1 &
  disown
) &
echo "next dev started, log: $LOG"
sleep 3
pgrep -fl "next dev|next-server" || true
