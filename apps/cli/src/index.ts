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
const GATEWAY = process.env.TERMINUS_GATEWAY ?? "http://127.0.0.1:81";
const PORT_PARAM = "XTransformPort=3050";

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
  const res = await fetch(forgeUrl(path));
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
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;
  const res = await fetch(forgeUrl(path), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    process.stderr.write(`error: POST ${path} -> HTTP ${res.status}: ${text}\n`);
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

async function streamEvents(taskId?: string, cursor?: string): Promise<void> {
  const params = new URLSearchParams();
  if (taskId) params.set("task_id", taskId);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  const url = forgeUrl(`/v1/events${qs ? `?${qs}` : ""}`);
  const res = await fetch(url, { headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) {
    process.stderr.write(`error: SSE HTTP ${res.status}\n`);
    process.exit(1);
  }
  const reader = res.body.getReader();
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

  if (!cmd || cmd === "help" || flags.help === true || flags.h === true) {
    showHelp();
    process.exit(cmd ? 0 : 2);
  }

  const idem = typeof flags.idempotency === "string" ? flags.idempotency : undefined;

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
        printJson(await apiMutate("/v1/workspaces/open", { root_uri: root }, idem));
        break;
      }
      case "new-session": {
        const wid = requireFlag(flags, "workspace");
        const title = requireFlag(flags, "title");
        printJson(await apiMutate("/v1/sessions", { workspace_id: wid, title }, idem));
        break;
      }
      case "new-task": {
        const sid = requireFlag(flags, "session");
        const tid = requireFlag(flags, "thread");
        const objective = requireFlag(flags, "objective");
        printJson(await apiMutate("/v1/tasks", { session_id: sid, thread_id: tid, objective }, idem));
        break;
      }
      case "start-task": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: start-task <id>\n"); process.exit(2); }
        printJson(await apiMutate(`/v1/tasks/${id}/start`, {}, idem));
        break;
      }
      case "cancel-task": {
        const id = positional[1];
        if (!id) { process.stderr.write("error: cancel-task <id>\n"); process.exit(2); }
        const reason = typeof flags.reason === "string" ? flags.reason : null;
        printJson(await apiMutate(`/v1/tasks/${id}/cancel`, { reason }));
        break;
      }
      case "start-turn": {
        const tid = requireFlag(flags, "thread");
        const taskId = requireFlag(flags, "task");
        const input = requireFlag(flags, "input");
        printJson(await apiMutate("/v1/turns", { thread_id: tid, task_id: taskId, user_input: input }, idem));
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
        printJson(await apiMutate(`/v1/approvals/${id}/resolve`, { decision, rationale }));
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
