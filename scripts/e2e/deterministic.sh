#!/usr/bin/env bash
# Deterministic lifecycle harness. The shell supervisor owns the two local
# services; the assertion runner only speaks the public control-plane API.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/terminus-e2e.XXXXXX")"
KERNEL_PID=""
CONTROL_PID=""
CONTROL_PORT=""
CONTROL_LOG=""
CONTROL_START_COUNT=0
SECOND_CONTROL_PID=""

cleanup() {
  status=$?
  set +e
  trap - EXIT
  if [[ -n "$CONTROL_PID" ]]; then
    kill "$CONTROL_PID" 2>/dev/null
    wait "$CONTROL_PID" 2>/dev/null
  fi
  if [[ -n "$SECOND_CONTROL_PID" ]]; then
    kill "$SECOND_CONTROL_PID" 2>/dev/null
    wait "$SECOND_CONTROL_PID" 2>/dev/null
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
# The standalone supervisor explicitly enables the UDS-only control bootstrap.
# The HTTP/TCP adapters remain unable to issue broker or maintenance tokens.
export TERMINUS_KERNEL_CONTROL_BOOTSTRAP=1
export TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN="e2e_bootstrap_0123456789abcdefghijklmnop"
export DATABASE_URL="file:$TMP_DIR/control.db"
mkdir -p "$TERMINUS_DATA"
# Register a real local root. Separate kernel integration coverage proves that
# multiple registered roots remain isolated; this lifecycle uses one root so
# its Git revision and verification fixtures stay deterministic.
export TERMINUS_E2E_WORKSPACE_ROOT="$TERMINUS_DATA"
# Port 0 keeps allocation atomic inside the control-plane listener. The
# supervisor reads the actual bound port from the service's startup record.
export TERMINUS_CONTROL_PORT="${TERMINUS_E2E_CONTROL_PORT:-0}"
mkdir -p "$TERMINUS_E2E_WORKSPACE_ROOT"
export TERMINUS_E2E_WORKSPACE_URI="$(
  python3 -c 'import pathlib, sys; print(pathlib.Path(sys.argv[1]).resolve().as_uri())' \
    "$TERMINUS_E2E_WORKSPACE_ROOT"
)"
export TERMINUS_E2E_WORKSPACE_CANONICAL_ROOT="$(
  python3 -c 'import pathlib, sys; print(pathlib.Path(sys.argv[1]).resolve())' \
    "$TERMINUS_E2E_WORKSPACE_ROOT"
)"
ln -s "$TERMINUS_E2E_WORKSPACE_CANONICAL_ROOT" "$TMP_DIR/workspace-alias"
export TERMINUS_E2E_WORKSPACE_ALIAS_URI="$(
  python3 -c 'import pathlib, sys; print(pathlib.Path(sys.argv[1]).absolute().as_uri())' \
    "$TMP_DIR/workspace-alias"
)"
cp "$ROOT/scripts/e2e/fixtures/read.txt" "$TERMINUS_DATA/e2e-fixture.txt"
cp "$ROOT/scripts/e2e/fixtures/read.txt" "$TERMINUS_DATA/scope-denied.txt"
cp "$ROOT/scripts/e2e/provider-stdio-fixture.ts" "$TERMINUS_DATA/terminus-provider-fixture.ts"
chmod 700 "$TERMINUS_DATA/terminus-provider-fixture.ts"
export TERMINUS_E2E_PROVIDER_RESPONSE_TEXT="Terminus provider fixture received local/e2e-model through kernel job input."
provider_runtime="$(command -v bun)"
export TERMINUS_LOCAL_PROVIDER_COMMAND_JSON="$(
  python3 -c '
import json, sys
print(json.dumps({
    "program": sys.argv[1],
    "args": [sys.argv[2]],
    "model": "local/e2e-model",
    "timeout_seconds": 10,
}, separators=(",", ":")))
' "$provider_runtime" "$TERMINUS_DATA/terminus-provider-fixture.ts"
)"
# The kernel's isolated data root is the execution workspace used by this
# harness. Give it a real immutable VCS baseline so verification can bind its
# plan and admission proof to an actual revision instead of a synthetic token.
git -C "$TERMINUS_DATA" init -q
git -C "$TERMINUS_DATA" config user.email "terminus-e2e@example.invalid"
git -C "$TERMINUS_DATA" config user.name "Terminus E2E"
git -C "$TERMINUS_DATA" add e2e-fixture.txt scope-denied.txt terminus-provider-fixture.ts
git -C "$TERMINUS_DATA" commit -q -m "e2e baseline"

echo "[e2e] preparing isolated SQLite database"
DATABASE_URL="$DATABASE_URL" bun run "$ROOT/scripts/migrate.ts" >"$TMP_DIR/migrate.log" 2>&1

# Simulate an upgrade from a control-plane-only workspace registry. The first
# standalone open must teach the empty kernel registry this exact durable ID;
# replacing it would strand every existing session foreign key.
export TERMINUS_E2E_PRESEEDED_WORKSPACE_ID="018f3f79-31a4-7a6c-8a7b-e2e000000001"
TERMINUS_TEST_DB="$TMP_DIR/control.db" \
TERMINUS_TEST_WORKSPACE_ID="$TERMINUS_E2E_PRESEEDED_WORKSPACE_ID" \
TERMINUS_TEST_WORKSPACE_URI="$TERMINUS_E2E_WORKSPACE_URI" \
TERMINUS_TEST_WORKSPACE_ROOT="$TERMINUS_E2E_WORKSPACE_CANONICAL_ROOT" \
  bun -e '
    import { Database } from "bun:sqlite";
    const path = process.env.TERMINUS_TEST_DB;
    const id = process.env.TERMINUS_TEST_WORKSPACE_ID;
    const rootUri = process.env.TERMINUS_TEST_WORKSPACE_URI;
    const canonicalRoot = process.env.TERMINUS_TEST_WORKSPACE_ROOT;
    if (!path || !id || !rootUri || !canonicalRoot) {
      throw new Error("workspace upgrade fixture is incomplete");
    }
    const now = Date.now();
    const db = new Database(path);
    db.query(`
      INSERT INTO workspaces (
        id, kind, root_uri, canonical_root, trust, policy_profile_id,
        created_at, last_opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      "local_directory",
      rootUri,
      canonicalRoot,
      "trusted",
      "secure-local-default",
      now,
      now,
    );
    db.close();
  '

echo "[e2e] starting kernel"
kernel_binary="$ROOT/mini-services/terminus-kernel/target/debug/terminus-kernel-mini"
CARGO_TARGET_DIR="$ROOT/mini-services/terminus-kernel/target" \
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
# Do not give the control plane the kernel's wildcard development token.
# It must bootstrap its broker and mint concrete task/workspace capabilities.
unset TERMINUS_KERNEL_CAP_TOKEN

start_control() {
  echo "[e2e] starting control plane"
  CONTROL_START_COUNT=$((CONTROL_START_COUNT + 1))
  CONTROL_LOG="$TMP_DIR/control-$CONTROL_START_COUNT.log"
  nohup bun run "$ROOT/mini-services/terminus-control/src/index.ts" </dev/null >"$CONTROL_LOG" 2>&1 &
  CONTROL_PID=$!

  for _ in $(seq 1 600); do
    CONTROL_PORT="$(
      sed -n 's/.*listening on http:\/\/localhost:\([0-9][0-9]*\).*/\1/p' "$CONTROL_LOG" \
        | tail -n 1
    )"
    if [[ -z "$CONTROL_PORT" ]]; then
      sleep 0.1
      continue
    fi
    if curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$CONTROL_PORT/v1/system/health" \
      -H "Authorization: Bearer $TERMINUS_CONTROL_TOKEN" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done

  if ! curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$CONTROL_PORT/v1/system/health" \
    -H "Authorization: Bearer $TERMINUS_CONTROL_TOKEN" >/dev/null; then
    echo "[e2e] control plane did not become healthy; see $CONTROL_LOG" >&2
    exit 1
  fi
}

start_control

echo "[e2e] proving the durable control-writer fence"
second_control_log="$TMP_DIR/control-fenced.log"
nohup bun run "$ROOT/mini-services/terminus-control/src/index.ts" </dev/null >"$second_control_log" 2>&1 &
SECOND_CONTROL_PID=$!
for _ in $(seq 1 100); do
  if ! kill -0 "$SECOND_CONTROL_PID" 2>/dev/null; then
    break
  fi
  sleep 0.05
done
if kill -0 "$SECOND_CONTROL_PID" 2>/dev/null; then
  echo "[e2e] second control process bypassed the writer fence; see $second_control_log" >&2
  exit 1
fi
wait "$SECOND_CONTROL_PID" 2>/dev/null || true
SECOND_CONTROL_PID=""
if ! grep -q "control writer lease is held" "$second_control_log"; then
  echo "[e2e] second control process failed for an unexpected reason; see $second_control_log" >&2
  exit 1
fi
curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$CONTROL_PORT/v1/system/health" \
  -H "Authorization: Bearer $TERMINUS_CONTROL_TOKEN" >/dev/null

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
export TERMINUS_E2E_TURN_ID="$(printf '%s' "$lifecycle_json" | json_field turn_id)"
export TERMINUS_E2E_THREAD_ID="$(printf '%s' "$lifecycle_json" | json_field thread_id)"
export TERMINUS_E2E_CHECKPOINT_ID="$(printf '%s' "$lifecycle_json" | json_field checkpoint_id)"
export TERMINUS_E2E_CHECKPOINT_ARTIFACT_HASH="$(printf '%s' "$lifecycle_json" | json_field checkpoint_artifact_hash)"
export TERMINUS_E2E_CONTRACT_FIXTURE_TASK_ID="$(printf '%s' "$lifecycle_json" | json_field contract_fixture_task_id)"
export TERMINUS_E2E_PENDING_RECOVERY_TASK_ID="$(printf '%s' "$lifecycle_json" | json_field pending_recovery_task_id)"
export TERMINUS_E2E_RESUME_TASK_ID="$(printf '%s' "$lifecycle_json" | json_field resume_task_id)"
export TERMINUS_E2E_RESUME_TURN_ID="$(printf '%s' "$lifecycle_json" | json_field resume_turn_id)"

echo "[e2e] proving transactional control-writer fencing"
TERMINUS_TEST_DB="$TMP_DIR/control.db" \
TERMINUS_E2E_CONTROL_URL="http://127.0.0.1:$CONTROL_PORT" \
TERMINUS_E2E_CONTROL_TOKEN="$TERMINUS_CONTROL_TOKEN" \
  bun run "$ROOT/scripts/e2e/assert-writer-fence.ts"

echo "[e2e] restarting control plane for recovery/resume proof"
kill "$CONTROL_PID" 2>/dev/null || true
wait "$CONTROL_PID" 2>/dev/null || true
CONTROL_PID=""
TERMINUS_TEST_DB="$TMP_DIR/control.db" \
TERMINUS_TEST_TASK_ID="$TERMINUS_E2E_CONTRACT_FIXTURE_TASK_ID" \
  bun -e '
    import { Database } from "bun:sqlite";
    const path = process.env.TERMINUS_TEST_DB;
    const taskId = process.env.TERMINUS_TEST_TASK_ID;
    if (!path || !taskId) throw new Error("contract ledger assertion is incomplete");
    // The writer is stopped. A normal handle can recreate SQLite WAL support
    // files; a read-only handle cannot open this cleanly checkpointed WAL DB.
    const db = new Database(path);
    const versions = db.query(`
      SELECT version
      FROM task_contract_versions
      WHERE task_id = ?
      ORDER BY version
    `).all(taskId).map((row) => row.version);
    const criteria = db.query(`
      SELECT contract_version, criterion_id, statement, verification_hint, required, status
      FROM acceptance_criteria
      WHERE task_id = ?
      ORDER BY contract_version, criterion_id
    `).all(taskId);
    const ledger = db.query(`
      SELECT contract_version, resource_uri, access_class, source
      FROM scope_ledger_entries
      WHERE task_id = ?
      ORDER BY contract_version, resource_uri, access_class
    `).all(taskId);
    const amendments = db.query(`
      SELECT aggregate_id
      FROM semantic_events
      WHERE event_type = ? AND correlation_id = ?
      ORDER BY event_id
    `).all("task.contract_amended", taskId);
    db.close();
    if (JSON.stringify(versions) !== JSON.stringify([1, 2])) {
      throw new Error(`rejected expansion created a contract version: ${JSON.stringify(versions)}`);
    }
    if (
      criteria.length !== 2
      || criteria.some((row, index) =>
        row.contract_version !== index + 1
        || row.criterion_id !== "retained-criterion"
        || row.statement !== "Same-scope amendments retain acceptance criteria."
        || row.verification_hint !== "deterministic persistence assertion"
        || row.required !== 1
        || row.status !== "pending"
      )
    ) {
      throw new Error(`same-scope amendment lost acceptance criteria: ${JSON.stringify(criteria)}`);
    }
    const expectedLedger = [
      { contract_version: 1, resource_uri: "external:example.test", access_class: "external_effective", source: "user_contract" },
      { contract_version: 1, resource_uri: "workspace:e2e-fixture.txt", access_class: "read_allowed", source: "user_contract" },
      { contract_version: 1, resource_uri: "workspace:e2e-fixture.txt", access_class: "write_allowed", source: "user_contract" },
      { contract_version: 2, resource_uri: "external:example.test", access_class: "external_effective", source: "contract_amendment" },
      { contract_version: 2, resource_uri: "workspace:e2e-fixture.txt", access_class: "read_allowed", source: "contract_amendment" },
      { contract_version: 2, resource_uri: "workspace:e2e-fixture.txt", access_class: "write_allowed", source: "contract_amendment" },
    ];
    if (JSON.stringify(ledger) !== JSON.stringify(expectedLedger)) {
      throw new Error(`contract scope ledger rows diverged: ${JSON.stringify(ledger)}`);
    }
    if (amendments.length !== 1 || amendments[0].aggregate_id !== `${taskId}@2`) {
      throw new Error(`rejected expansion created or removed an event: ${JSON.stringify(amendments)}`);
    }
  '
# Simulate the precise crash window after the kernel owner link exists but
# before the control-plane publication flips PREPARED → COMMITTED. Startup
# must repair this row before accepting public requests.
TERMINUS_TEST_DB="$TMP_DIR/control.db" \
TERMINUS_TEST_CHECKPOINT="$TERMINUS_E2E_CHECKPOINT_ID" \
  bun -e '
    import { Database } from "bun:sqlite";
    const path = process.env.TERMINUS_TEST_DB;
    const checkpoint = process.env.TERMINUS_TEST_CHECKPOINT;
    if (!path || !checkpoint) throw new Error("checkpoint recovery fixture is incomplete");
    const db = new Database(path);
    const changed = db.query("UPDATE checkpoints SET admission_state = ? WHERE id = ?").run("PREPARED", checkpoint);
    db.close();
    if (changed.changes !== 1) throw new Error(`expected one checkpoint fixture, changed ${changed.changes}`);
  '

control_fixture_json="$(
  TERMINUS_TEST_DB="$TMP_DIR/control.db" \
  TERMINUS_TEST_TASK_ID="$TERMINUS_E2E_TASK_ID" \
  TERMINUS_TEST_SSE_TASK_ID="$TERMINUS_E2E_CONTRACT_FIXTURE_TASK_ID" \
  TERMINUS_TEST_PENDING_RECOVERY_TASK_ID="$TERMINUS_E2E_PENDING_RECOVERY_TASK_ID" \
    bun run "$ROOT/scripts/e2e/seed-control-invariants.ts"
)"
export TERMINUS_E2E_SSE_CURSOR="$(printf '%s' "$control_fixture_json" | json_field sse_cursor)"
export TERMINUS_E2E_SSE_TASK_ID="$(printf '%s' "$control_fixture_json" | json_field sse_task_id)"
export TERMINUS_E2E_SSE_EVENT_COUNT="$(printf '%s' "$control_fixture_json" | json_field sse_event_count)"
export TERMINUS_E2E_EXPECTED_TASK_VERSION="$(printf '%s' "$control_fixture_json" | json_field expected_task_version)"
export TERMINUS_E2E_EXPECTED_TASK_STATUS="$(printf '%s' "$control_fixture_json" | json_field expected_task_status)"

# Reproduce a pre-task-binding checkpoint link from an older artifact-store
# schema. The control plane is stopped and the kernel is idle while this
# test-only row is admitted; restart reconciliation must remove it after the
# grace period instead of deferring it forever because owner_task_id is empty.
export TERMINUS_E2E_LEGACY_ORPHAN_ID="e2e-legacy-empty-owner-orphan"
TERMINUS_TEST_ARTIFACT_DB="$TERMINUS_DATA/artifacts/metadata.db" \
TERMINUS_TEST_CHECKPOINT="$TERMINUS_E2E_CHECKPOINT_ID" \
TERMINUS_TEST_ORPHAN="$TERMINUS_E2E_LEGACY_ORPHAN_ID" \
  bun -e '
    import { Database } from "bun:sqlite";
    const path = process.env.TERMINUS_TEST_ARTIFACT_DB;
    const checkpoint = process.env.TERMINUS_TEST_CHECKPOINT;
    const orphan = process.env.TERMINUS_TEST_ORPHAN;
    if (!path || !checkpoint || !orphan) throw new Error("legacy owner fixture is incomplete");
    const db = new Database(path);
    const source = db.query(`
      SELECT artifact_hash
      FROM artifact_links
      WHERE owner_type = ? AND owner_id = ? AND purpose = ?
      LIMIT 1
    `).get("checkpoint", checkpoint, "content");
    if (!source) throw new Error(`checkpoint ${checkpoint} had no artifact link to clone`);
    db.query(`
      INSERT INTO artifact_links (
        id, artifact_hash, owner_type, owner_id, owner_task_id, purpose, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "e2e-legacy-empty-owner-link",
      source.artifact_hash,
      "checkpoint",
      orphan,
      "",
      "content",
      "1970-01-01T00:00:00.000Z",
    );
    db.close();
  '
start_control

if ! grep -q "snapshot version .* does not advance" "$CONTROL_LOG"; then
  echo "[e2e] ARP v2 replay did not report the regressed snapshot fixture; see $CONTROL_LOG" >&2
  exit 1
fi
if ! grep -q "snapshot identity .* does not match aggregate" "$CONTROL_LOG"; then
  echo "[e2e] ARP v2 replay did not report the wrong-identity snapshot fixture; see $CONTROL_LOG" >&2
  exit 1
fi
TERMINUS_TEST_ARTIFACT_DB="$TERMINUS_DATA/artifacts/metadata.db" \
TERMINUS_TEST_ORPHAN="$TERMINUS_E2E_LEGACY_ORPHAN_ID" \
  bun -e '
    import { Database } from "bun:sqlite";
    const path = process.env.TERMINUS_TEST_ARTIFACT_DB;
    const orphan = process.env.TERMINUS_TEST_ORPHAN;
    if (!path || !orphan) throw new Error("legacy owner assertion is incomplete");
    const db = new Database(path, { readonly: true });
    const remaining = db.query(`
      SELECT COUNT(*) AS count
      FROM artifact_links
      WHERE owner_type = ? AND owner_id = ? AND owner_task_id = ? AND purpose = ?
    `).get("checkpoint", orphan, "", "content");
    db.close();
    if (remaining.count !== 0) {
      throw new Error(`legacy empty-owner orphan survived restart: ${JSON.stringify(remaining)}`);
    }
  '

restart_json="$(
  TERMINUS_E2E_CONTROL_URL="http://127.0.0.1:$CONTROL_PORT" \
    TERMINUS_E2E_CONTROL_TOKEN="$TERMINUS_CONTROL_TOKEN" \
    bun run "$ROOT/scripts/e2e/assert-restart.ts"
)"
echo "$restart_json"

projection_task_id="$(printf '%s' "$restart_json" | json_field projection_task_id)"
resumed_turn_id="$(printf '%s' "$restart_json" | json_field resumed_turn_id)"
TERMINUS_TEST_DB="$TMP_DIR/control.db" \
TERMINUS_TEST_INITIAL_TURN_ID="$TERMINUS_E2E_TURN_ID" \
TERMINUS_TEST_RESUMED_TURN_ID="$resumed_turn_id" \
  bun run "$ROOT/scripts/e2e/assert-control-persistence.ts"
TERMINUS_TEST_DB="$TMP_DIR/control.db" \
TERMINUS_TEST_TASK_ID="$projection_task_id" \
  bun -e '
    import { Database } from "bun:sqlite";
    const path = process.env.TERMINUS_TEST_DB;
    const taskId = process.env.TERMINUS_TEST_TASK_ID;
    if (!path || !taskId) throw new Error("contract projection fixture is incomplete");
    const db = new Database(path, { readonly: true });
    const row = db.query(`
      SELECT budget_json, scope_digest
      FROM tasks
      WHERE id = ?
    `).get(taskId);
    db.close();
    if (!row) throw new Error(`projected task ${taskId} was not durable`);
    const budget = JSON.parse(row.budget_json);
    const scope = JSON.parse(row.scope_digest);
    if (
      budget.model_micros !== "424242"
      || budget.compute_seconds !== 123
      || budget.wall_clock_seconds !== 123
    ) {
      throw new Error(`v2 budget did not reach the v1 task row: ${JSON.stringify(budget)}`);
    }
    if (
      JSON.stringify(scope.read_paths) !== JSON.stringify(["/src/**"])
      || JSON.stringify(scope.write_paths) !== JSON.stringify(["/tmp/output.txt"])
      || JSON.stringify(scope.external_systems) !== JSON.stringify(["example.test"])
    ) {
      throw new Error(`v2 scope did not reach the v1 task row: ${JSON.stringify(scope)}`);
    }
  '

echo "[e2e] verifying ARP v2 client parity (CLI ↔ graphical adapter) on the live daemon"
TERMINUS_E2E_CONTROL_URL="http://127.0.0.1:$CONTROL_PORT" \
  TERMINUS_E2E_CONTROL_TOKEN="$TERMINUS_CONTROL_TOKEN" \
  bun test "$ROOT/tests/e2e/arp_v2_lifecycle.test.ts"

echo "[e2e] running complete end-to-end turn integration spine (PR 7)"
TERMINUS_E2E_CONTROL_URL="http://127.0.0.1:$CONTROL_PORT" \
  TERMINUS_E2E_CONTROL_TOKEN="$TERMINUS_CONTROL_TOKEN" \
  TERMINUS_E2E_WORKSPACE_ROOT="$TERMINUS_E2E_WORKSPACE_ROOT" \
  TERMINUS_E2E_WORKSPACE_ID="$TERMINUS_E2E_PRESEEDED_WORKSPACE_ID" \
  TERMINUS_TEST_DB="$TMP_DIR/control.db" \
  bun test "$ROOT/tests/e2e/turn_integration_spine.test.ts"

echo "[e2e] PASS"
