#!/bin/bash
# Start Next.js dev server in a fully detached subshell that survives shell exits.
# Uses webpack (not Turbopack) to reduce memory pressure on small hosts.
pkill -f "next dev" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true
sleep 1
cd /home/z/my-project
( setsid bash -c 'cd /home/z/my-project && exec node node_modules/.bin/next dev -p 3000 --webpack' </dev/null >/tmp/terminus-next.log 2>&1 & disown ) &
echo "next dev started, log: /tmp/terminus-next.log"
sleep 3
ps -ef | grep -E "next dev|next-server" | grep -v grep
