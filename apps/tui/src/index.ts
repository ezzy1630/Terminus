import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TerminusClient } from "@terminus/public-client";
import { createTuiClient, TuiApp } from "./app.js";

const GATEWAY = process.env.TERMINUS_GATEWAY ?? "http://127.0.0.1:81";
let cachedClient: TerminusClient | null = null;

function terminusToken(): string {
  const token = process.env.TERMINUS_TOKEN;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("TERMINUS_TOKEN must be set to a non-empty local authentication token");
  }
  return token;
}

function publicClient(): TerminusClient {
  cachedClient ??= createTuiClient(GATEWAY, terminusToken());
  return cachedClient;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function mutationKey(operationId: string, step: string): string {
  return `tui:${operationId}:${step}`;
}

function truncate(value: string, width: number): string {
  const characters = [...value];
  return characters.length <= width ? value : `${characters.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function pad(value: string, width: number): string {
  const clipped = truncate(value, width);
  return clipped + " ".repeat(Math.max(0, width - [...clipped].length));
}

function colorStatus(status: string): string {
  const lower = status.toLowerCase();
  if (["completed", "active", "ok", "ready", "pass", "allowed"].includes(lower)) return `\u001b[32m${status}\u001b[0m`;
  if (["failed", "denied", "down", "error", "aborted", "revoked"].includes(lower)) return `\u001b[31m${status}\u001b[0m`;
  if (["pending", "running", "verifying", "proposed", "prompt", "degraded"].includes(lower)) return `\u001b[33m${status}\u001b[0m`;
  return status;
}

async function showHealth(): Promise<void> {
  const health = await publicClient().health();
  console.log("\n┌─ System health ──────────────────────────────────────────────");
  console.log(`│ status:     ${colorStatus(health.status)}`);
  console.log(`│ version:    ${health.version}`);
  console.log(`│ instance:   ${health.instance_id}`);
  console.log(`│ uptime:     ${Math.floor(health.uptime_seconds)}s`);
  console.log(`│ ready:      ${health.ready}`);
  if (health.kernel) {
    console.log("├─ Effect enforcement ─────────────────────────────────────────");
    console.log(`│ status:     ${colorStatus(health.kernel.status ?? "unknown")}`);
    const report = health.kernel.enforcement_report;
    if (report?.enforced?.length) console.log(`│ enforced:   ${report.enforced.join(", ")}`);
    if (report?.unsupported?.length) console.log(`│ unsupported:${report.unsupported.join(", ")}`);
  }
  console.log("└──────────────────────────────────────────────────────────────");
}

async function showSessions(): Promise<void> {
  const result = await publicClient().listSessions();
  console.log("\n┌─ Sessions ───────────────────────────────────────────────────");
  if (result.sessions.length === 0) console.log("│ No sessions");
  else {
    console.log(`│ ${pad("ID", 14)}  ${pad("STATUS", 10)}  ${pad("TITLE", 24)}  UPDATED`);
    for (const session of result.sessions.slice(0, 50)) {
      console.log(`│ ${pad(session.id, 14)}  ${colorStatus(pad(session.status, 10))}  ${pad(session.title, 24)}  ${session.updated_at}`);
    }
    if (result.sessions.length > 50) console.log(`│ Output truncated. ${result.sessions.length - 50} sessions remain; use the interactive TUI to browse them.`);
  }
  console.log("└──────────────────────────────────────────────────────────────");
}

async function showTasks(sessionId: string | undefined): Promise<void> {
  if (!sessionId) throw new Error("usage: tasks <session-id>");
  const result = await publicClient().listSessionTasks(sessionId);
  console.log(`\n┌─ Tasks in ${truncate(sessionId, 20)} ───────────────────────────────────`);
  if (result.tasks.length === 0) console.log("│ No tasks");
  else {
    console.log(`│ ${pad("ID", 14)}  ${pad("STATUS", 16)}  ${pad("PHASE", 18)}  UPDATED`);
    for (const task of result.tasks.slice(0, 50)) {
      console.log(`│ ${pad(task.id, 14)}  ${colorStatus(pad(task.status, 16))}  ${pad(task.phase, 18)}  ${task.updated_at}`);
    }
    if (result.tasks.length > 50) console.log(`│ Output truncated. ${result.tasks.length - 50} tasks remain; use the interactive TUI to browse them.`);
  }
  console.log("└──────────────────────────────────────────────────────────────");
}

async function subscribeEvents(taskId: string | undefined): Promise<void> {
  console.log(`\nLive events${taskId ? ` for ${taskId}` : ""}. Press Ctrl+C to stop.`);
  for await (const event of publicClient().subscribeEvents({ task_id: taskId ?? null })) {
    console.log(`[${new Date().toISOString()}] ${event.event} ${event.id} ${truncate(event.data, 160)}`);
  }
}

async function createTask(): Promise<void> {
  const input = createInterface({ input: stdin, output: stdout });
  try {
    const workspaceUri = await input.question("Workspace root: ");
    const title = await input.question("Session title: ");
    const objective = await input.question("Task objective: ");
    const firstMessage = await input.question("First request: ");
    if (!workspaceUri.trim() || !objective.trim() || !firstMessage.trim()) {
      throw new Error("workspace, objective, and first request are required");
    }
    const client = publicClient();
    const operationId = `${process.pid}:${Date.now().toString(36)}`;
    const workspace = await client.openWorkspace(
      { root_uri: workspaceUri.trim() },
      { idempotencyKey: mutationKey(operationId, "workspace") },
    );
    const session = await client.createSession(
      { workspace_id: workspace.id, title: title.trim() || objective.trim() },
      { idempotencyKey: mutationKey(operationId, "session") },
    );
    if (!session.active_thread_id) throw new Error(`session ${session.id} has no active thread`);
    const task = await client.createTask(
      { session_id: session.id, thread_id: session.active_thread_id, objective: objective.trim() },
      { idempotencyKey: mutationKey(operationId, "task") },
    );
    await client.startTask(task.id, { idempotencyKey: mutationKey(operationId, "start") });
    const turn = await client.startTurn(
      { thread_id: session.active_thread_id, task_id: task.id, user_input: firstMessage.trim() },
      { idempotencyKey: mutationKey(operationId, "turn") },
    );
    console.log(`Started task ${task.id} and turn ${turn.id}.`);
  } finally {
    input.close();
  }
}

async function showOrganizations(): Promise<void> {
  const [organizations, departments] = await Promise.all([
    publicClient().listOrganizationsV2(),
    publicClient().listDepartmentsV2(),
  ]);
  console.log("\nOrganizations");
  for (const organization of organizations.organizations) console.log(`  ${organization.displayName}  ${organization.id}`);
  console.log("\nDepartments");
  for (const department of departments.departments) console.log(`  ${department.displayName}  ${department.id}`);
}

async function showCockpit(taskId: string | undefined): Promise<void> {
  if (!taskId) throw new Error("usage: cockpit <task-id>");
  const [task, attention] = await Promise.all([
    publicClient().getTaskV2(taskId),
    publicClient().assessTaskAttentionV2(taskId),
  ]);
  console.log(`\n${task.contract.mission}`);
  console.log(`status:    ${colorStatus(task.status)}`);
  console.log(`attention: ${attention.requiresAttention ? `${attention.urgency} — ${attention.reason}` : "none"}`);
}

async function showAttention(taskId: string | undefined): Promise<void> {
  const result = await publicClient().listMaterialQuestionsV2(taskId);
  if (result.questions.length === 0) {
    console.log("No pending material questions.");
    return;
  }
  for (const question of result.questions) {
    console.log(`\n${question.questionText}  [${question.trigger}]`);
    for (const option of question.options) console.log(`  ${option}: ${question.consequenceMatrix[option] ?? "No consequence supplied"}`);
  }
}

function showHelp(): void {
  console.log(`
Terminus terminal client

  terminus-tui                    Open the full-screen TUI
  terminus-tui tui                Open the full-screen TUI
  terminus-tui health             Show system health
  terminus-tui sessions           List sessions
  terminus-tui tasks <session>    List tasks
  terminus-tui events [task]      Stream events
  terminus-tui new                Create and start a task
  terminus-tui orgs               List organization topology
  terminus-tui cockpit <task>     Show task attention state
  terminus-tui attention [task]   List material questions

Environment
  TERMINUS_GATEWAY  Gateway URL. Default: http://127.0.0.1:81
  TERMINUS_TOKEN    Required local authentication token
`);
}

async function runInteractive(): Promise<void> {
  const app = new TuiApp({ client: publicClient() });
  try {
    await app.start();
  } catch (error) {
    app.stop();
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "tui";
  switch (command) {
    case "tui": await runInteractive(); break;
    case "health": await showHealth(); break;
    case "sessions": await showSessions(); break;
    case "tasks": await showTasks(args[1]); break;
    case "events": await subscribeEvents(args[1]); break;
    case "new": await createTask(); break;
    case "orgs": await showOrganizations(); break;
    case "cockpit": await showCockpit(args[1]); break;
    case "attention": await showAttention(args[1]); break;
    case "help":
    case "--help":
    case "-h": showHelp(); break;
    default:
      showHelp();
      throw new Error(`unknown command: ${command}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`error: ${errorMessage(error)}`);
  process.exitCode = 1;
}
