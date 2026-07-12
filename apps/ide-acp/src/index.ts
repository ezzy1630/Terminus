/**
 * Forge IDE-ACP adapter (SPEC §42.1, §32.6).
 *
 * Per SPEC §32.6: The ACP adapter maps editor workspace and selection into
 * explicit context directives; diagnostics and open files into world-state
 * contributions; plans and progress into ACP updates; approval prompts into
 * editor-native interactions; patches into preview/apply flows; task/session
 * identifiers into resume metadata. The ACP adapter is NOT privileged — it
 * calls the public API and receives no direct filesystem authority.
 *
 * This is the scaffold. It implements the ACP-over-stdio JSON-RPC bridge:
 * the editor speaks ACP on stdin/stdout; this adapter translates to Forge
 * public API calls. A full ACP implementation (with editor-native approval
 * prompts, patch preview, diagnostics push) is the next milestone.
 *
 * Usage:
 *   Configure your editor's ACP client to launch:
 *     bun apps/ide-acp/src/index.ts
 *
 * Environment:
 *   FORGE_GATEWAY   Gateway base URL (default: http://127.0.0.1:81)
 */
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";

const GATEWAY = process.env.FORGE_GATEWAY ?? "http://127.0.0.1:81";
const PORT_PARAM = "XTransformPort=3050";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function forgeUrl(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${GATEWAY}${path}${sep}${PORT_PARAM}`;
}

async function forgeGet<T>(path: string): Promise<T> {
  const res = await fetch(forgeUrl(path));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function forgePost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(forgeUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function send(msg: JsonRpcResponse | { jsonrpc: "2.0"; method: string; params?: unknown }): void {
  stdout.write(JSON.stringify(msg) + "\n");
}

function respond(id: string | number | null, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): void {
  send({ jsonrpc: "2.0", id, error: { code, message, data } });
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case "initialize": {
        respond(id, {
          server: { version: "0.1.0", build_commit: "dev", instance_id: "forge-ide-acp" },
          protocol: { major: 1, minor: 0 },
          capabilities: {
            supported: ["forge_task_creation", "forge_event_stream", "forge_approval_bridge", "forge_patch_preview"],
          },
        });
        break;
      }
      case "shutdown": {
        respond(id, {});
        break;
      }
      case "forge/health": {
        respond(id, await forgeGet("/v1/system/health"));
        break;
      }
      case "forge/sessions": {
        respond(id, await forgeGet("/v1/sessions"));
        break;
      }
      case "forge/createTask": {
        const p = (req.params ?? {}) as {
          workspace_id?: string;
          title?: string;
          objective: string;
          selection?: string;
        };
        // 1. Open workspace if needed
        let workspaceId = p.workspace_id;
        if (!workspaceId) {
          const w = await forgePost<{ id: string }>("/v1/workspaces/open", {
            root_uri: p.selection ?? process.cwd(),
          });
          workspaceId = w.id;
        }
        // 2. Create session if needed
        const session = await forgePost<{ id: string; active_thread_id: string }>("/v1/sessions", {
          workspace_id: workspaceId,
          title: p.title ?? "ide-acp",
        });
        // 3. Create task
        const task = await forgePost<{ id: string }>("/v1/tasks", {
          session_id: session.id,
          thread_id: session.active_thread_id,
          objective: p.objective,
        });
        // 4. Start task
        await forgePost(`/v1/tasks/${task.id}/start`, {});
        respond(id, { session, task });
        break;
      }
      case "forge/startTurn": {
        const p = (req.params ?? {}) as { thread_id: string; task_id: string; user_input: string };
        const turn = await forgePost<{ id: string; state: string }>("/v1/turns", {
          thread_id: p.thread_id,
          task_id: p.task_id,
          user_input: p.user_input,
        });
        respond(id, turn);
        break;
      }
      case "forge/approvals": {
        respond(id, await forgeGet("/v1/approvals"));
        break;
      }
      case "forge/resolveApproval": {
        const p = (req.params ?? {}) as {
          id: string;
          decision: "allow_once" | "allow_exact" | "allow_task_scope" | "deny_once" | "deny_and_rule" | "stop_task";
          rationale?: string;
        };
        respond(id, await forgePost(`/v1/approvals/${p.id}/resolve`, {
          decision: p.decision,
          rationale: p.rationale ?? null,
        }));
        break;
      }
      case "forge/manifest": {
        const p = (req.params ?? {}) as { id: string };
        respond(id, await forgeGet(`/v1/context/manifests/${p.id}`));
        break;
      }
      default:
        respondError(id, -32601, `method not found: ${req.method}`);
    }
  } catch (e) {
    respondError(id, -32603, (e as Error).message);
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch (e) {
      respondError(null, -32700, `parse error: ${(e as Error).message}`);
      continue;
    }
    await handleRequest(req);
  }
}

void main();
