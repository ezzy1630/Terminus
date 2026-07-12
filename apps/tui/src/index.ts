/**
 * Terminus TUI — terminal client (SPEC §43.4 primary client).
 *
 * Per SPEC §43.4: "TUI: reuse or adapt the inherited OpenCode TUI initially."
 * Per SPEC §32.5: clients reconnect by authenticating, fetching the
 * task/session snapshot, resuming events from the last durable cursor,
 * reconciling pending local UI actions by idempotency key, rendering active
 * approvals and jobs, and attaching to desired streams.
 *
 * This is the scaffold. It connects to the public API (port 3050 via the
 * Caddy gateway), subscribes to the SSE event stream, and renders a
 * live view of sessions, tasks, turns, approvals, and events. A full TUI
 * (with ink/blessed-style rendering, approval prompts, context manifest
 * inspection, etc.) is the next milestone.
 *
 * Usage:
 *   bun apps/tui/src/index.ts [--gateway http://127.0.0.1:81] [--token <...>]
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const GATEWAY = process.env.TERMINUS_GATEWAY ?? "http://127.0.0.1:81";
const PORT_PARAM = "XTransformPort=3050";

interface HealthResponse {
  status: string;
  version: string;
  build_commit: string;
  instance_id: string;
  uptime_seconds: number;
  ready: boolean;
  kernel?: { status?: string; ready?: boolean; enforcement_report?: { status?: string; enforced?: string[]; unsupported?: string[] } };
}

interface SessionListResponse {
  sessions: Array<{
    id: string;
    title: string;
    status: string;
    active_thread_id: string | null;
    created_at: string;
    updated_at: string;
  }>;
}

interface TaskListResponse {
  tasks: Array<{
    id: string;
    status: string;
    phase: string;
    active_contract_version: number;
    created_at: string;
    updated_at: string;
  }>;
}

function forgeUrl(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${GATEWAY}${path}${sep}${PORT_PARAM}`;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(forgeUrl(path));
  if (!res.ok) {
    throw new Error(`GET ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function formatStatus(status: string): string {
  const lower = status.toLowerCase();
  if (["completed", "active", "ok", "ready", "pass", "allowed"].includes(lower)) {
    return `\x1b[32m${status}\x1b[0m`;
  }
  if (["failed", "denied", "down", "error", "aborted", "revoked"].includes(lower)) {
    return `\x1b[31m${status}\x1b[0m`;
  }
  if (["pending", "running", "verifying", "proposed", "prompt", "degraded"].includes(lower)) {
    return `\x1b[33m${status}\x1b[0m`;
  }
  return status;
}

async function showHealth(): Promise<void> {
  const h = await apiGet<HealthResponse>("/v1/system/health");
  console.log("\n┌─ System health ──────────────────────────────────────────────");
  console.log(`│ status:     ${formatStatus(h.status)}`);
  console.log(`│ version:    ${h.version}`);
  console.log(`│ instance:   ${h.instance_id}`);
  console.log(`│ uptime:     ${Math.floor(h.uptime_seconds)}s`);
  console.log(`│ ready:      ${h.ready}`);
  if (h.kernel) {
    console.log("├─ Kernel ─────────────────────────────────────────────────────");
    console.log(`│ kernel:     ${formatStatus(h.kernel.status ?? "?")}`);
    if (h.kernel.enforcement_report) {
      const er = h.kernel.enforcement_report;
      console.log(`│ enforcement:${formatStatus(er.status ?? "?")}`);
      if (er.enforced && er.enforced.length > 0) {
        console.log(`│ enforced:   ${er.enforced.join(", ")}`);
      }
      if (er.unsupported && er.unsupported.length > 0) {
        console.log(`│ unsupported:${er.unsupported.join(", ")}`);
      }
    }
  }
  console.log("└──────────────────────────────────────────────────────────────");
}

async function showSessions(): Promise<SessionListResponse> {
  const r = await apiGet<SessionListResponse>("/v1/sessions");
  console.log("\n┌─ Sessions ───────────────────────────────────────────────────");
  if (r.sessions.length === 0) {
    console.log("│ (no sessions)");
  } else {
    console.log(`│ ${pad("ID", 14)}  ${pad("STATUS", 10)}  ${pad("TITLE", 24)}  UPDATED`);
    for (const s of r.sessions.slice(0, 10)) {
      console.log(
        `│ ${pad(truncate(s.id, 14), 14)}  ${formatStatus(pad(s.status, 10))}  ${pad(truncate(s.title, 24), 24)}  ${s.updated_at}`,
      );
    }
    if (r.sessions.length > 10) {
      console.log(`│ … and ${r.sessions.length - 10} more`);
    }
  }
  console.log("└──────────────────────────────────────────────────────────────");
  return r;
}

async function showTasks(sessionId?: string): Promise<void> {
  if (sessionId) {
    const r = await apiGet<TaskListResponse>(`/v1/sessions/${sessionId}/tasks`);
    console.log(`\n┌─ Tasks in session ${truncate(sessionId, 12)} ────────────────────`);
    if (r.tasks.length === 0) {
      console.log("│ (no tasks)");
    } else {
      console.log(`│ ${pad("ID", 14)}  ${pad("STATUS", 14)}  ${pad("PHASE", 12)}  UPDATED`);
      for (const t of r.tasks.slice(0, 10)) {
        console.log(
          `│ ${pad(truncate(t.id, 14), 14)}  ${formatStatus(pad(t.status, 14))}  ${pad(t.phase, 12)}  ${t.updated_at}`,
        );
      }
    }
    console.log("└──────────────────────────────────────────────────────────────");
  } else {
    console.log("\n(specify a session id to list tasks: tasks <session-id>)");
  }
}

async function subscribeEvents(filter?: string): Promise<void> {
  const url = forgeUrl(`/v1/events${filter ? `?task_id=${filter}` : ""}`);
  console.log(`\n┌─ Live event stream (${filter ? `task=${filter}` : "all"}) ──────────────────────`);
  console.log(`│ ${url}`);
  console.log("│ (press Ctrl+C to stop streaming)");
  console.log("└──────────────────────────────────────────────────────────────");
  const res = await fetch(url, { headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) {
    throw new Error(`SSE failed: HTTP ${res.status}`);
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
          else if (line.startsWith(":heartbeat")) {
            process.stdout.write(".");
          }
        }
        if (dataLines.length > 0) {
          const data = dataLines.join("\n");
          const time = new Date().toISOString().slice(11, 19);
          console.log(`[${time}] ${formatStatus(eventType)} ${truncate(eventId, 12)} ${truncate(data, 80)}`);
        }
        dataLines = [];
        eventType = "";
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function createTask(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const workspaceUri = await rl.question("Workspace root URI (e.g. /tmp/terminus-demo): ");
    const title = await rl.question("Session title: ");
    const objective = await rl.question("Task objective: ");
    const userInput = await rl.question("First turn user input: ");

    // 1. Open workspace
    const wRes = await fetch(forgeUrl("/v1/workspaces/open"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root_uri: workspaceUri || "/tmp/terminus-demo" }),
    });
    if (!wRes.ok) throw new Error(`workspace: HTTP ${wRes.status}`);
    const w = (await wRes.json()) as { id: string };
    console.log(`✓ workspace ${w.id}`);

    // 2. Create session
    const sRes = await fetch(forgeUrl("/v1/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: w.id, title: title || "tui" }),
    });
    if (!sRes.ok) throw new Error(`session: HTTP ${sRes.status}`);
    const s = (await sRes.json()) as { id: string; active_thread_id: string };
    console.log(`✓ session ${s.id} (thread ${s.active_thread_id})`);

    // 3. Create task
    const tRes = await fetch(forgeUrl("/v1/tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: s.id,
        thread_id: s.active_thread_id,
        objective: objective || "tui demo",
      }),
    });
    if (!tRes.ok) throw new Error(`task: HTTP ${tRes.status}`);
    const t = (await tRes.json()) as { id: string };
    console.log(`✓ task ${t.id}`);

    // 4. Start task
    await fetch(forgeUrl(`/v1/tasks/${t.id}/start`), { method: "POST" });
    console.log(`✓ task activated`);

    // 5. Start turn
    const turnRes = await fetch(forgeUrl("/v1/turns"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        thread_id: s.active_thread_id,
        task_id: t.id,
        user_input: userInput || "hello",
      }),
    });
    if (!turnRes.ok) throw new Error(`turn: HTTP ${turnRes.status}`);
    const turn = (await turnRes.json()) as { id: string };
    console.log(`✓ turn ${turn.id} started — agent loop running`);

    console.log(`\nWatch it complete:`);
    console.log(`  bun apps/tui/src/index.ts events ${t.id}`);
  } finally {
    rl.close();
  }
}

function showHelp(): void {
  console.log(`
Terminus TUI — commands:
  health              Show system + kernel health
  sessions            List recent sessions
  tasks <session-id>  List tasks in a session
  events [task-id]    Subscribe to the live SSE event stream
  new                 Create a workspace + session + task + turn interactively
  help                Show this help
  exit                Quit

Environment:
  TERMINUS_GATEWAY       Gateway base URL (default: http://127.0.0.1:81)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "health";

  try {
    switch (cmd) {
      case "health":
        await showHealth();
        break;
      case "sessions":
        await showSessions();
        break;
      case "tasks":
        await showTasks(args[1]);
        break;
      case "events":
        await subscribeEvents(args[1]);
        break;
      case "new":
        await createTask();
        break;
      case "help":
      case "--help":
      case "-h":
        showHelp();
        break;
      case "exit":
      case "quit":
        break;
      default:
        console.log(`unknown command: ${cmd}`);
        showHelp();
        process.exit(1);
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}

void main();
