#!/usr/bin/env bash
# Cold-start the exact packaged control artifact against the exact kernel binary.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTROL_ARCHIVE=""
KERNEL_BINARY=""
EXPECTED_COMMIT=""
EXPECTED_VERSION=""
ALLOW_DIRTY=0

for argument in "$@"; do
  case "$argument" in
    --control-archive=*) CONTROL_ARCHIVE="${argument#*=}" ;;
    --kernel-binary=*) KERNEL_BINARY="${argument#*=}" ;;
    --commit=*) EXPECTED_COMMIT="${argument#*=}" ;;
    --version=*) EXPECTED_VERSION="${argument#*=}" ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    *) echo "unknown argument: $argument" >&2; exit 2 ;;
  esac
done

if [[ -z "$CONTROL_ARCHIVE" || -z "$KERNEL_BINARY" ]]; then
  echo "usage: smoke-control-runtime.sh --control-archive=<tar.gz> --kernel-binary=<path> [--commit=<sha>] [--version=<semver>]" >&2
  exit 2
fi
CONTROL_ARCHIVE="$(cd "$(dirname "$CONTROL_ARCHIVE")" && pwd)/$(basename "$CONTROL_ARCHIVE")"
KERNEL_BINARY="$(cd "$(dirname "$KERNEL_BINARY")" && pwd)/$(basename "$KERNEL_BINARY")"
[[ -f "$CONTROL_ARCHIVE" ]] || { echo "control archive does not exist: $CONTROL_ARCHIVE" >&2; exit 1; }
[[ -f "$KERNEL_BINARY" ]] || { echo "kernel binary does not exist: $KERNEL_BINARY" >&2; exit 1; }

verify_arguments=("$CONTROL_ARCHIVE")
[[ -n "$EXPECTED_COMMIT" ]] && verify_arguments+=("--commit=$EXPECTED_COMMIT")
[[ -n "$EXPECTED_VERSION" ]] && verify_arguments+=("--version=$EXPECTED_VERSION")
[[ "$ALLOW_DIRTY" -eq 1 ]] && verify_arguments+=("--allow-dirty")
bun run "$ROOT/scripts/verify-control-runtime-package.ts" "${verify_arguments[@]}" >/dev/null

SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/terminus-control-smoke.XXXXXX")"
KERNEL_PID=""
CONTROL_PID=""
cleanup() {
  result=$?
  set +e
  trap - EXIT
  if [[ -n "$CONTROL_PID" ]]; then kill "$CONTROL_PID" 2>/dev/null; wait "$CONTROL_PID" 2>/dev/null; fi
  if [[ -n "$KERNEL_PID" ]]; then kill "$KERNEL_PID" 2>/dev/null; wait "$KERNEL_PID" 2>/dev/null; fi
  if [[ "$result" -ne 0 ]]; then
    echo "control runtime cold-start failed" >&2
    [[ -f "$SMOKE_ROOT/control.log" ]] && tail -c 8000 "$SMOKE_ROOT/control.log" >&2
    [[ -f "$SMOKE_ROOT/kernel.log" ]] && tail -c 4000 "$SMOKE_ROOT/kernel.log" >&2
  fi
  rm -rf "$SMOKE_ROOT"
  exit "$result"
}
trap cleanup EXIT INT TERM

tar -xzf "$CONTROL_ARCHIVE" -C "$SMOKE_ROOT"
RUNTIME="$SMOKE_ROOT/terminus-control/bin/terminus-control"
[[ -x "$RUNTIME" ]] || { echo "packaged runtime is not executable: $RUNTIME" >&2; exit 1; }
cp "$KERNEL_BINARY" "$SMOKE_ROOT/terminus-kernel-mini"
chmod 700 "$SMOKE_ROOT/terminus-kernel-mini"

export DATABASE_URL="file:$SMOKE_ROOT/control.db"
export TERMINUS_DATA="$SMOKE_ROOT/kernel-data"
export TERMINUS_KERNEL_GRPC_SOCKET="$SMOKE_ROOT/kernel.sock"
export TERMINUS_KERNEL_REQUIRE_UDS=1
export TERMINUS_KERNEL_CONTROL_BOOTSTRAP=1
export TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN="smoke_bootstrap_0123456789abcdefghijkl"
export TERMINUS_KERNEL_TOKEN="terminus-control-smoke-kernel-token"
export TERMINUS_KERNEL_CAPABILITY_SECRET="terminus-control-smoke-capability-secret-v1"
export TERMINUS_CONTROL_TOKEN="terminus-control-smoke-bearer-token"
export TERMINUS_CONTROL_PORT=0
mkdir -p "$TERMINUS_DATA"

cd "$SMOKE_ROOT"
"$RUNTIME" migrate >"$SMOKE_ROOT/migrate-first.log" 2>&1
"$RUNTIME" migrate >"$SMOKE_ROOT/migrate-second.log" 2>&1
grep -q "migrations complete: 0 applied" "$SMOKE_ROOT/migrate-second.log" || {
  echo "packaged migrations are not idempotent" >&2
  exit 1
}

"$SMOKE_ROOT/terminus-kernel-mini" >"$SMOKE_ROOT/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 300); do
  [[ -S "$TERMINUS_KERNEL_GRPC_SOCKET" ]] && break
  kill -0 "$KERNEL_PID" 2>/dev/null || break
  sleep 0.1
done
[[ -S "$TERMINUS_KERNEL_GRPC_SOCKET" ]] || { echo "kernel UDS did not become ready" >&2; exit 1; }

"$RUNTIME" serve >"$SMOKE_ROOT/control.log" 2>&1 &
CONTROL_PID=$!
CONTROL_PORT=""
for _ in $(seq 1 300); do
  CONTROL_PORT="$(sed -n 's/.*listening on http:\/\/localhost:\([0-9][0-9]*\).*/\1/p' "$SMOKE_ROOT/control.log" | tail -n 1)"
  [[ -n "$CONTROL_PORT" ]] && break
  kill -0 "$CONTROL_PID" 2>/dev/null || break
  sleep 0.1
done
[[ -n "$CONTROL_PORT" ]] || { echo "control runtime did not publish a listening port" >&2; exit 1; }

curl --noproxy '*' -fsS --max-time 5 \
  "http://127.0.0.1:$CONTROL_PORT/v1/system/health" \
  -H "Authorization: Bearer $TERMINUS_CONTROL_TOKEN" >"$SMOKE_ROOT/health.json"
TERMINUS_SMOKE_HEALTH="$SMOKE_ROOT/health.json" bun -e '
  const health = await Bun.file(process.env.TERMINUS_SMOKE_HEALTH).json();
  if (health.status !== "ok" || health.ready !== true || health.writer?.healthy !== true) {
    throw new Error(`packaged control runtime is not ready: ${JSON.stringify(health)}`);
  }
'

identity="$($RUNTIME version)"
TERMINUS_SMOKE_IDENTITY="$identity" \
TERMINUS_SMOKE_COMMIT="$EXPECTED_COMMIT" \
TERMINUS_SMOKE_VERSION="$EXPECTED_VERSION" \
bun -e '
  const identity = JSON.parse(process.env.TERMINUS_SMOKE_IDENTITY ?? "null");
  if (identity?.schema !== "terminus.control-runtime.identity.v1") throw new Error("invalid runtime identity");
  const commit = process.env.TERMINUS_SMOKE_COMMIT;
  const version = process.env.TERMINUS_SMOKE_VERSION;
  if (commit && identity.candidate_commit !== commit) throw new Error("runtime commit mismatch");
  if (version && identity.version !== version) throw new Error("runtime version mismatch");
'

printf '{"schema":"terminus.control-runtime.smoke.v1","status":"pass","target":"%s","health":"ok"}\n' \
  "$(TERMINUS_SMOKE_IDENTITY="$identity" bun -e 'console.log(JSON.parse(process.env.TERMINUS_SMOKE_IDENTITY).target)')"
