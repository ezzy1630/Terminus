/**
 * Terminus CLI — non-interactive client for CI and automation (SPEC §42.1).
 *
 * Per SPEC §32.3: starting a task returns immediately with an event cursor;
 * clients subscribe to events. Long-running HTTP requests MUST NOT own
 * durable execution.
 *
 * Usage:
 *   terminus <command> [options]
 *
 * Commands:
 *   health                          Print system + kernel health as JSON
 *   sessions                        List sessions as JSON
 *   session <id>                    Get a session snapshot as JSON
 *   tasks <session-id>              List tasks in a session as JSON
 *   task <id>                       Get a task snapshot as JSON
 *   new-workspace --root <uri>      Open a workspace; print snapshot
 *   new-session --workspace <id> --title <t>   Create a session; print snapshot
 *   new-task --session <id> --thread <id> --objective <o>
 *                                   Create a task; print snapshot
 *   start-task <id>                 Activate a DRAFT task
 *   cancel-task <id> [--reason <r>] Cancel a task
 *   start-turn --thread <id> --task <id> --input <text>
 *                                   Start a turn (triggers the agent loop)
 *   wait <task-id> [--timeout <s>]  Poll a task until terminal state
 *   events [--task <id>] [--cursor <id>]  Stream SSE events as JSONL
 *   manifest <id>                   Get a context manifest as JSON
 *   artifact <hash>                 Download artifact bytes to stdout
 *   approvals                       List pending approvals as JSON
 *   resolve-approval <id> --decision <d> [--rationale <r>]
 *   evals                           List eval suites + baselines as JSON
 *   config                          Print effective configuration as JSON
 *
 * ARP v2 Commands:
 *   health-v2                       Check v2 system health
 *   schema-registry                 Get v2 schema registry metadata
 *   task-v2 <id>                    Get v2 task snapshot
 *   new-task-v2 --objective <o> [--session <id> --thread <id>]
 *                                    Create an operational or conversation-backed v2 task
 *   transition-task-v2 <id> --status <s>
 *                                   Transition v2 task state (READY, RUNNING, etc.)
 *   propose-effect --task <id> --class <c> --intent <i>
 *                                   Propose transactional effect
 *   advance-effect <id> --to <s>    Advance an effect to the next canonical
 *                                   state (server enforces the state machine)
 *   commit-effect <id>              Commit prepared effect
 *   submit-claim --task <id> --statement <s>
 *                                   Submit an acceptance claim
 *   record-evidence --claim <id> --summary <s> --result <r>
 *                                   Record evidence against claim
 *   events-v2 [--task <id>] [--cursor <c>]
 *                                   Stream ARP v2 resumable events
 *
 * Options:
 *   --gateway <url>    Gateway base URL (default: http://127.0.0.1:81, env: TERMINUS_GATEWAY)
 *   --token <t>        Bearer token (env: TERMINUS_TOKEN)
 *   --idempotency <k>  Idempotency key for mutating requests
 *   --help, -h         Show help
 *
 * Exit codes:
 *   0   success
 *   1   generic error
 *   2   usage error
 *   3   timeout
 */
import { randomUUID } from "node:crypto";
import { ProposeInterventionRequestV2 } from "@terminus/public-api";

const GATEWAY = process.env.TERMINUS_GATEWAY ?? "http://127.0.0.1:81";
const PORT_PARAM = "XTransformPort=3050";
// Bearer token for control planes that require auth (SPEC §30.8). The
// well-known dev token is only used when TERMINUS_DEV=1 so production
// deployments cannot accidentally authenticate with a public constant.
function resolveToken(cliToken?: string): string {
  if (cliToken && cliToken.length > 0) return cliToken;
  const env = process.env.TERMINUS_TOKEN;
  if (env && env.length > 0) return env;
  if (process.env.TERMINUS_DEV === "1") return "terminus-control-dev-token";
  return "";
}
let BEARER_TOKEN = "";

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function forgeUrl(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${GATEWAY}${path}${sep}${PORT_PARAM}`;
}

async function apiGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (BEARER_TOKEN) headers.authorization = `Bearer ${BEARER_TOKEN}`;
  const res = await fetch(forgeUrl(path), { headers });
  if (!res.ok) {
    const text = await res.text();
    process.stderr.write(`error: GET ${path} -> HTTP ${res.status}: ${text}\n`);
    process.exit(1);
  }
  return (await res.json()) as T;
}

async function apiMutate<T>(
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<T> {
  if (idempotencyKey.trim().length === 0) {
    throw new TypeError("Idempotency-Key must be a non-empty string");
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (BEARER_TOKEN) headers.authorization = `Bearer ${BEARER_TOKEN}`;
  headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(forgeUrl(path), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    process.stderr.write(`error: POST ${path} -> HTTP ${res.status}: ${text}\nidempotency-key: ${idempotencyKey}\n`);
    process.exit(1);
  }
  return (await res.json()) as T;
}

function printJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) {
    process.stderr.write(`error: --${name} is required\n`);
    process.exit(2);
  }
  return v;
}

function usageError(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

function requireJsonObjectFlag(flags: Record<string, string | boolean>, name: string): Record<string, unknown> {
  const raw = requireFlag(flags, name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    process.stderr.write(`error: --${name} must be valid JSON\n`);
    process.exit(2);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    process.stderr.write(`error: --${name} must be a JSON object\n`);
    process.exit(2);
  }
  return parsed as Record<string, unknown>;
}

function requireInterventionPayload(
  flags: Record<string, string | boolean>,
  verb: string,
  taskId: string,
  targetEntityId: string | null,
  rationale: string,
): Record<string, unknown> {
  if (flags.payload === true) usageError("--payload requires a JSON object value");
  const payload = flags.payload === undefined ? {} : requireJsonObjectFlag(flags, "payload");
  const parsed = ProposeInterventionRequestV2.safeParse({
    taskId,
    verb,
    targetEntityId,
    payload,
    rationale,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
      .join("; ");
    usageError(`--payload is invalid for --verb ${verb}: ${detail}`);
  }
  return payload;
}

async function waitTask(
  taskId: string,
  timeoutSec: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  const terminalStates = new Set([
    "COMPLETED", "FAILED", "FAILED_VERIFICATION", "BUDGET_EXHAUSTED",
    "POLICY_DENIED", "ABORTED",
  ]);
  let lastStatus = "";
  while (Date.now() < deadline) {
    const t = await apiGet<{ status: string; phase: string }>(`/v1/tasks/${taskId}`);
    if (t.status !== lastStatus) {
      process.stderr.write(`task ${taskId}: ${t.status} / ${t.phase}\n`);
      lastStatus = t.status;
    }
    if (terminalStates.has(t.status)) {
      printJson(t);
      process.exit(t.status === "COMPLETED" ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stderr.write(`error: timeout waiting for task ${taskId}\n`);
  process.exit(3);
}

async function streamSse(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventId = "";
  let eventType = "";
  let dataLines: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf("\n\n");
        if (idx < 0) break;
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) eventId = line.slice(3).trim();
          else if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (dataLines.length > 0) {
          const data = dataLines.join("\n");
          let payload: unknown = data;
          try { payload = JSON.parse(data); } catch { /* keep as string */ }
          printJson({ id: eventId, event: eventType, data: payload });
        }
        dataLines = [];
        eventType = "";
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function streamEvents(taskId?: string, cursor?: string): Promise<void> {
  const params = new URLSearchParams();
  if (taskId) params.set("task_id", taskId);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  const url = forgeUrl(`/v1/events${qs ? `?${qs}` : ""}`);
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (BEARER_TOKEN) headers.authorization = `Bearer ${BEARER_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) {
    process.stderr.write(`error: SSE HTTP ${res.status}\n`);
    process.exit(1);
  }
  await streamSse(res.body);
}

function showHelp(): void {
  process.stdout.write(`
Terminus CLI — non-interactive client for CI and automation (SPEC §42.1).

Commands:
  health                          System + kernel health (JSON)
  sessions                        List sessions (JSON)
  session <id>                    Session snapshot (JSON)
  tasks <session-id>              Tasks in a session (JSON)
  task <id>                       Task snapshot (JSON)
  new-workspace --root <uri>      Open a workspace
  new-session --workspace <id> --title <t>   Create a session
  new-task --session <id> --thread <id> --objective <o>   Create a task
  start-task <id>                 Activate a DRAFT task
  cancel-task <id> [--reason <r>] Cancel a task
  start-turn --thread <id> --task <id> --input <text>   Start a turn
  wait <task-id> [--timeout <s>]  Poll until terminal state
  events [--task <id>] [--cursor <id>]   Stream SSE events as JSONL
  manifest <id>                   Context manifest (JSON)
  artifact <hash>                 Download artifact bytes to stdout
  approvals                       Pending approvals (JSON)
  resolve-approval <id> --decision <d> [--rationale <r>]
  evals                           Eval suites + baselines (JSON)
  config                          Effective configuration (JSON)

ARP v2 Commands:
  health-v2                       v2 system health (JSON)
  schema-registry                 v2 schema registry (JSON)
  task-v2 <id>                    v2 task snapshot (JSON)
  new-task-v2 --objective <o> [--session <id> --thread <id>]
                                  Create a canonical v2 task
  transition-task-v2 <id> --status <s> [--expected-version <n>]
                                  Transition the v2 task state machine
  propose-effect --task <id> --class <c> --intent <i>
                                  Propose a transactional effect
  advance-effect <id> --to <s>    Advance an effect state (server-validated)
  commit-effect <id> [--expected-version <n>]
                                  Commit a VALIDATED effect
  submit-claim --task <id> --statement <s>
  record-evidence --claim <id> --summary <s> --result <r>
  events-v2 [--task <id>] [--cursor <c>]   Stream v2 SSE envelopes as JSONL

Operator cockpit:
  orgs | departments [--org <id>] | operators [--dept <id>] | agent-rooms [--dept <id>]
  directory | resolve-capability --capability <id> [--category <name>]
  assess-attention <task-id> | questions-material [--task <id>]
  resolve-question-material <id> --option <value>
  intervene --task <id> --verb <verb> --rationale <text> [--payload <json>]
  apply-intervention <id> | interventions [--task <id>]
  replay <task-id> | counterfactual --task <id> --type <type>
  mobile-supervise <task-id> | mobile-action --task <id> --action <action>

Options:
  --gateway <url>    Gateway base URL (env: TERMINUS_GATEWAY, default: http://127.0.0.1:81)
  --token <t>        Bearer token (env: TERMINUS_TOKEN)
  --idempotency <k>  Idempotency key for mutating requests
  --help, -h         Show this help

Exit codes: 0=ok, 1=error, 2=usage, 3=timeout
`);
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  BEARER_TOKEN = resolveToken(typeof flags.token === "string" ? flags.token : undefined);

  if (!cmd || cmd === "help" || flags.help === true || flags.h === true) {
    showHelp();
    process.exit(cmd ? 0 : 2);
  }

  const explicitIdempotency = typeof flags.idempotency === "string" ? flags.idempotency.trim() : null;
  if (typeof flags.idempotency === "string" && explicitIdempotency?.length === 0) {
    process.stderr.write("error: --idempotency must be a non-empty string\n");
    process.exit(2);
  }
  const mutationKey = explicitIdempotency ?? `cli:${cmd}:${randomUUID()}`;

  try {
    switch (cmd) {
      case "health": {
        printJson(await apiGet("/v1/system/health"));
        break;
      }
      case "sessions": {
        printJson(await apiGet("/v1/sessions"));
        break;
      }
      case "session": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: session <id>\n"); process.exit(2); }
        printJson(await apiGet(`/v1/sessions/${id}`));
        break;
      }
      case "tasks": {
        const sid = positional[1];
        if (!sid) { process.stderr.write("error: tasks <session-id>\n"); process.exit(2); }
        printJson(await apiGet(`/v1/sessions/${sid}/tasks`));
        break;
      }
      case "task": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: task <id>\n"); process.exit(2); }
        printJson(await apiGet(`/v1/tasks/${id}`));
        break;
      }
      case "new-workspace": {
        const root = requireFlag(flags, "root");
        printJson(await apiMutate("/v1/workspaces/open", { root_uri: root }, mutationKey));
        break;
      }
      case "new-session": {
        const wid = requireFlag(flags, "workspace");
        const title = requireFlag(flags, "title");
        printJson(await apiMutate("/v1/sessions", { workspace_id: wid, title }, mutationKey));
        break;
      }
      case "new-task": {
        const sid = requireFlag(flags, "session");
        const tid = requireFlag(flags, "thread");
        const objective = requireFlag(flags, "objective");
        printJson(await apiMutate("/v1/tasks", { session_id: sid, thread_id: tid, objective }, mutationKey));
        break;
      }
      case "start-task": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: start-task <id>\n"); process.exit(2); }
        printJson(await apiMutate(`/v1/tasks/${id}/start`, {}, mutationKey));
        break;
      }
      case "cancel-task": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: cancel-task <id>\n"); process.exit(2); }
        const reason = typeof flags.reason === "string" ? flags.reason : null;
        printJson(await apiMutate(`/v1/tasks/${id}/cancel`, { reason }, mutationKey));
        break;
      }
      case "start-turn": {
        const tid = requireFlag(flags, "thread");
        const taskId = requireFlag(flags, "task");
        const input = requireFlag(flags, "input");
        printJson(await apiMutate("/v1/turns", { thread_id: tid, task_id: taskId, user_input: input }, mutationKey));
        break;
      }
      case "wait": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: wait <task-id>\n"); process.exit(2); }
        const timeout = typeof flags.timeout === "string" ? parseInt(flags.timeout, 10) : 120;
        await waitTask(id, timeout);
        break;
      }
      case "events": {
        const task = typeof flags.task === "string" ? flags.task : undefined;
        const cursor = typeof flags.cursor === "string" ? flags.cursor : undefined;
        await streamEvents(task, cursor);
        break;
      }
      case "manifest": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: manifest <id>\n"); process.exit(2); }
        printJson(await apiGet(`/v1/context/manifests/${id}`));
        break;
      }
      case "artifact": {
        const hash = positional[1];
        if (!hash) { process.stderr.write("error: artifact <hash>\n"); process.exit(2); }
        const res = await fetch(forgeUrl(`/v1/artifacts/${hash}`));
        if (!res.ok) {
          process.stderr.write(`error: HTTP ${res.status}\n`);
          process.exit(1);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        process.stdout.write(buf);
        break;
      }
      case "approvals": {
        printJson(await apiGet("/v1/approvals"));
        break;
      }
      case "resolve-approval": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: resolve-approval <id>\n"); process.exit(2); }
        const decision = requireFlag(flags, "decision") as
          | "allow_once" | "allow_exact" | "allow_task_scope"
          | "deny_once" | "deny_and_rule" | "stop_task";
        const rationale = typeof flags.rationale === "string" ? flags.rationale : null;
        printJson(await apiMutate(`/v1/approvals/${id}/resolve`, { decision, rationale }, mutationKey));
        break;
      }
      case "evals": {
        printJson(await apiGet("/v1/evals"));
        break;
      }
      case "config": {
        printJson(await apiGet("/v1/configuration"));
        break;
      }
      // ────────────────────── ARP v2 Commands ───────────────────────────────
      case "health-v2": {
        printJson(await apiGet("/v2/system/health"));
        break;
      }
      case "schema-registry": {
        printJson(await apiGet("/v2/system/schema-registry"));
        break;
      }
      case "task-v2": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: task-v2 <id>\n"); process.exit(2); }
        printJson(await apiGet(`/v2/tasks/${id}`));
        break;
      }
      case "new-task-v2": {
        const objective = requireFlag(flags, "objective");
        const mission = typeof flags.mission === "string" ? flags.mission : null;
        const sessionId = typeof flags.session === "string" ? flags.session : null;
        const threadId = typeof flags.thread === "string" ? flags.thread : null;
        if ((sessionId === null) !== (threadId === null)) {
          process.stderr.write("error: --session and --thread must be supplied together\n");
          process.exit(2);
        }
        const mode = typeof flags.mode === "string" ? flags.mode : sessionId === null ? "operational" : "interactive";
        // JSON has no bigint: Micros travel as decimal strings on the wire
        // and the control plane coerces them back to bigint at the boundary.
        const body = {
          missionId: mission,
          organizationId: "default-org",
          departmentId: "default-dept",
          v1Context: sessionId === null || threadId === null ? null : { sessionId, threadId },
          contract: {
            version: 1,
            mission: objective,
            scope: { resources: [], allowedEffectClasses: ["LOCAL_FS_WRITE", "LOCAL_PROCESS_SPAWN"], excludedPathsOrSystems: [] },
            acceptance: [{ claimId: "claim-1", statement: objective, evidenceRequirement: "DETERMINISTIC_TEST" }],
            constraints: { security: ["NO_AMBIENT_SECRETS"], costMicros: "10000000", timeoutSeconds: 3600 },
            authorityCeiling: ["FS_WRITE", "PROCESS_SPAWN"],
            mode,
          },
        };
        printJson(await apiMutate("/v2/tasks", body, mutationKey));
        break;
      }
      case "transition-task-v2": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: transition-task-v2 <id>\n"); process.exit(2); }
        const status = requireFlag(flags, "status");
        const expVer = typeof flags["expected-version"] === "string" ? parseInt(flags["expected-version"], 10) : null;
        printJson(await apiMutate(`/v2/tasks/${id}/transition`, { id, targetStatus: status, expectedVersion: expVer }, mutationKey));
        break;
      }
      case "propose-effect": {
        const taskId = requireFlag(flags, "task");
        const effectClass = requireFlag(flags, "class");
        const intent = requireFlag(flags, "intent");
        const worker = typeof flags.worker === "string" ? flags.worker : "local_worker";
        const body = {
          taskId,
          attemptId: "att-1",
          connectorOrWorker: worker,
          intentType: intent,
          canonicalParameters: {},
          resourceHandles: [],
          effectClass,
          semanticIdempotencyKey: mutationKey,
        };
        printJson(await apiMutate("/v2/effects", body, mutationKey));
        break;
      }
      case "commit-effect": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: commit-effect <id>\n"); process.exit(2); }
        const expVer = typeof flags["expected-version"] === "string" ? parseInt(flags["expected-version"], 10) : null;
        printJson(await apiMutate(`/v2/effects/${id}/commit`, { id, expectedVersion: expVer }, mutationKey));
        break;
      }
      case "advance-effect": {
        // Drive an effect through its canonical state machine
        // (PROPOSED → POLICY_CHECKED → … → COMMITTED). The server enforces
        // EFFECT_TRANSITIONS; illegal jumps are rejected with 409.
        const id = positional[1];
        if (!id) { process.stderr.write("error: advance-effect <id> --to <STATE>\n"); process.exit(2); }
        const to = requireFlag(flags, "to");
        const expVer = typeof flags["expected-version"] === "string" ? parseInt(flags["expected-version"], 10) : null;
        printJson(await apiMutate(`/v2/effects/${id}/transition`, { targetState: to, expectedVersion: expVer }, mutationKey));
        break;
      }
      case "submit-claim": {
        const taskId = requireFlag(flags, "task");
        const statement = requireFlag(flags, "statement");
        const evidence = typeof flags.evidence === "string" ? flags.evidence : "DETERMINISTIC_TEST";
        printJson(await apiMutate("/v2/claims", { taskId, statement, requiredEvidenceKind: evidence }, mutationKey));
        break;
      }
      case "record-evidence": {
        const claimId = requireFlag(flags, "claim");
        const summary = requireFlag(flags, "summary");
        const result = requireFlag(flags, "result");
        const body = { claimId, kind: "DETERMINISTIC_TEST", summary, verifierResult: result };
        printJson(await apiMutate("/v2/evidence", body, mutationKey));
        break;
      }
      case "events-v2": {
        const task = typeof flags.task === "string" ? flags.task : undefined;
        const cursor = typeof flags.cursor === "string" ? flags.cursor : undefined;
        const params = new URLSearchParams();
        if (task) params.set("taskId", task);
        if (cursor) params.set("cursor", cursor);
        const qs = params.toString();
        const url = forgeUrl(`/v2/events${qs ? `?${qs}` : ""}`);
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (BEARER_TOKEN) headers.authorization = `Bearer ${BEARER_TOKEN}`;
        const res = await fetch(url, { headers });
        if (!res.ok || !res.body) {
          process.stderr.write(`error: SSE HTTP ${res.status}\n`);
          process.exit(1);
        }
        await streamSse(res.body);
        break;
      }
      case "orgs": {
        printJson(await apiGet("/v2/organizations"));
        break;
      }
      case "departments": {
        const orgId = typeof flags.org === "string" ? flags.org : undefined;
        const qs = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : "";
        printJson(await apiGet(`/v2/departments${qs}`));
        break;
      }
      case "operators": {
        const deptId = typeof flags.dept === "string" ? flags.dept : undefined;
        const qs = deptId ? `?departmentId=${encodeURIComponent(deptId)}` : "";
        printJson(await apiGet(`/v2/operators${qs}`));
        break;
      }
      case "agent-rooms": {
        const deptId = typeof flags.dept === "string" ? flags.dept : undefined;
        const qs = deptId ? `?departmentId=${encodeURIComponent(deptId)}` : "";
        printJson(await apiGet(`/v2/agent-rooms${qs}`));
        break;
      }
      case "directory": {
        printJson(await apiGet("/v2/capabilities/directory"));
        break;
      }
      case "resolve-capability": {
        const cap = requireFlag(flags, "capability");
        const category = typeof flags.category === "string" ? flags.category : undefined;
        printJson(await apiMutate("/v2/capabilities/resolve", { capabilityId: cap, category }, mutationKey));
        break;
      }
      case "assess-attention": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: assess-attention <task-id>\n"); process.exit(2); }
        printJson(await apiGet(`/v2/attention/assess/${encodeURIComponent(id)}`));
        break;
      }
      case "questions-material": {
        const taskId = typeof flags.task === "string" ? flags.task : undefined;
        const qs = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";
        printJson(await apiGet(`/v2/attention/questions${qs}`));
        break;
      }
      case "resolve-question-material": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: resolve-question-material <id> --option <o>\n"); process.exit(2); }
        const option = requireFlag(flags, "option");
        printJson(await apiMutate(`/v2/attention/questions/${encodeURIComponent(id)}/resolve`, { id, selectedOption: option }, mutationKey));
        break;
      }
      case "intervene": {
        const taskId = requireFlag(flags, "task");
        const verb = requireFlag(flags, "verb");
        const rationale = requireFlag(flags, "rationale");
        const target = typeof flags.target === "string" ? flags.target : null;
        const payload = requireInterventionPayload(flags, verb, taskId, target, rationale);
        printJson(await apiMutate("/v2/interventions", {
          taskId,
          verb,
          targetEntityId: target,
          payload,
          rationale,
        }, mutationKey));
        break;
      }
      case "apply-intervention": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: apply-intervention <id>\n"); process.exit(2); }
        printJson(await apiMutate(`/v2/interventions/${encodeURIComponent(id)}/apply`, { id }, mutationKey));
        break;
      }
      case "interventions": {
        const taskId = typeof flags.task === "string" ? flags.task : undefined;
        const qs = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";
        printJson(await apiGet(`/v2/interventions${qs}`));
        break;
      }
      case "replay": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: replay <task-id>\n"); process.exit(2); }
        printJson(await apiGet(`/v2/replay/traces/${encodeURIComponent(id)}`));
        break;
      }
      case "counterfactual": {
        const taskId = requireFlag(flags, "task");
        const type = requireFlag(flags, "type");
        printJson(await apiMutate("/v2/replay/counterfactual", {
          sourceTaskId: taskId,
          variationType: type,
          variationDetails: {},
        }, mutationKey));
        break;
      }
      case "mobile-supervise": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: mobile-supervise <task-id>\n"); process.exit(2); }
        printJson(await apiGet(`/v2/mobile/sessions/${encodeURIComponent(id)}`));
        break;
      }
      case "mobile-action": {
        const taskId = requireFlag(flags, "task");
        const action = requireFlag(flags, "action");
        printJson(await apiMutate(`/v2/mobile/sessions/${encodeURIComponent(taskId)}/action`, {
          taskId,
          action,
        }, mutationKey));
        break;
      }
      default:
        process.stderr.write(`error: unknown command "${cmd}"\n`);
        showHelp();
        process.exit(2);

    }
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

void main();
