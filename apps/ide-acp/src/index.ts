/**
 * Terminus IDE-ACP adapter (SPEC §42.1, §32.6).
 *
 * Per SPEC §32.6: The ACP adapter maps editor workspace and selection into
 * explicit context directives; diagnostics and open files into world-state
 * contributions; plans and progress into ACP updates; approval prompts into
 * editor-native interactions; patches into preview/apply flows; task/session
 * identifiers into resume metadata. The ACP adapter is NOT privileged — it
 * calls the public API and receives no direct filesystem authority.
 *
 * This is a custom JSON-RPC-over-stdio bridge. It is intentionally not labeled
 * as ACP v1: the method names and initialize result are Terminus-specific.
 * A standards-compliant ACP adapter (with editor-native approval prompts,
 * patch preview, and diagnostics push) is a separate milestone.
 *
 * Usage:
 *   Configure your editor's ACP client to launch:
 *     bun apps/ide-acp/src/index.ts
 *
 * Environment:
 *   TERMINUS_GATEWAY   Gateway base URL (default: http://127.0.0.1:81)
 *   TERMINUS_TOKEN     Required local authentication token
 */
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { ApprovalDecisionParam, V2_ENDPOINTS } from "@terminus/public-api";
import { ForgeClient, type MutationRequestOptions } from "@terminus/public-client";

const GATEWAY = process.env.TERMINUS_GATEWAY ?? "http://127.0.0.1:81";
let cachedClient: ForgeClient | null = null;

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

function terminusToken(): string {
  const token = process.env.TERMINUS_TOKEN;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("TERMINUS_TOKEN must be set to a non-empty local authentication token");
  }
  return token;
}

function publicClient(): ForgeClient {
  cachedClient ??= new ForgeClient({
    baseUrl: GATEWAY,
    xformPort: 3050,
    token: terminusToken(),
  });
  return cachedClient;
}

function paramsRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("JSON-RPC params must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredStringParam(value: unknown, name: string): string {
  const candidate = paramsRecord(value)[name];
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new TypeError(`JSON-RPC param '${name}' must be a non-empty string`);
  }
  return candidate;
}

function optionalStringParam(value: unknown, name: string): string | undefined {
  const candidate = paramsRecord(value)[name];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new TypeError(`JSON-RPC param '${name}' must be a non-empty string when provided`);
  }
  return candidate;
}

function publicParams(value: unknown): Readonly<Record<string, unknown>> {
  const params = paramsRecord(value);
  return Object.fromEntries(
    Object.entries(params).filter(([name]) => name !== "idempotencyKey"),
  );
}

function mutationOptions(req: JsonRpcRequest, step: string): MutationRequestOptions {
  const params = req.params === undefined ? {} : paramsRecord(req.params);
  const explicitKey = params.idempotencyKey;
  let operationKey: string;
  if (explicitKey !== undefined) {
    if (typeof explicitKey !== "string" || explicitKey.trim().length === 0) {
      throw new TypeError("JSON-RPC param 'idempotencyKey' must be a non-empty string");
    }
    operationKey = explicitKey;
  } else {
    if (req.id === undefined || req.id === null) {
      throw new TypeError("mutating JSON-RPC requests require an id or idempotencyKey");
    }
    operationKey = `acp:${req.method}:${String(req.id)}`;
  }
  return { idempotencyKey: `${operationKey}:${step}` };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
  const record = paramsRecord(value);
  if (record.jsonrpc !== "2.0") {
    throw new TypeError("JSON-RPC version must be '2.0'");
  }
  if (typeof record.method !== "string" || record.method.trim().length === 0) {
    throw new TypeError("JSON-RPC method must be a non-empty string");
  }
  const requestId = record.id;
  if (
    requestId !== undefined
    && requestId !== null
    && typeof requestId !== "string"
    && typeof requestId !== "number"
  ) {
    throw new TypeError("JSON-RPC id must be a string, number, or null");
  }
  return {
    jsonrpc: "2.0",
    method: record.method,
    ...(requestId === undefined ? {} : { id: requestId }),
    ...(record.params === undefined ? {} : { params: record.params }),
  };
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
          server: { version: "0.1.0", build_commit: "dev", instance_id: "terminus-ide-acp" },
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
      case "terminus/health": {
        respond(id, await publicClient().health());
        break;
      }
      case "terminus/sessions": {
        respond(id, await publicClient().listSessions());
        break;
      }
      case "terminus/createTask": {
        const p = publicParams(req.params ?? {});
        const client = publicClient();
        const objective = requiredStringParam(p, "objective");
        // 1. Open workspace if needed
        let workspaceId = optionalStringParam(p, "workspace_id");
        if (!workspaceId) {
          const w = await client.openWorkspace(
            { root_uri: optionalStringParam(p, "selection") ?? process.cwd() },
            mutationOptions(req, "open-workspace"),
          );
          workspaceId = w.id;
        }
        // 2. Create session if needed
        const session = await client.createSession(
          {
            workspace_id: workspaceId,
            title: optionalStringParam(p, "title") ?? "ide-acp",
          },
          mutationOptions(req, "create-session"),
        );
        if (session.active_thread_id === null) {
          throw new Error(`session ${session.id} has no active thread`);
        }
        // 3. Create task
        const task = await client.createTask(
          {
            session_id: session.id,
            thread_id: session.active_thread_id,
            objective,
          },
          mutationOptions(req, "create-task"),
        );
        // 4. Start task
        await client.startTask(task.id, mutationOptions(req, "start-task"));
        respond(id, { session, task });
        break;
      }
      case "terminus/startTurn": {
        const p = publicParams(req.params ?? {});
        const turn = await publicClient().startTurn(
          {
            thread_id: requiredStringParam(p, "thread_id"),
            task_id: requiredStringParam(p, "task_id"),
            user_input: requiredStringParam(p, "user_input"),
          },
          mutationOptions(req, "start-turn"),
        );
        respond(id, turn);
        break;
      }
      case "terminus/approvals": {
        respond(id, await publicClient().listApprovals());
        break;
      }
      case "terminus/resolveApproval": {
        const p = publicParams(req.params ?? {});
        const decision = ApprovalDecisionParam.parse(p.decision);
        respond(id, await publicClient().resolveApproval(
          requiredStringParam(p, "id"),
          requiredStringParam(p, "operation_hash"),
          decision,
          {
            ...mutationOptions(req, "resolve-approval"),
            rationale: optionalStringParam(p, "rationale") ?? null,
          },
        ));
        break;
      }
      case "terminus/manifest": {
        respond(id, await publicClient().getContextManifest(requiredStringParam(req.params, "id")));
        break;
      }
      case "terminus/v2/contextSync": {
        const input = V2_ENDPOINTS.SyncAcpContextV2.request.parse(
          publicParams(req.params ?? {}),
        );
        respond(id, await publicClient().syncAcpContextV2(
          input,
          mutationOptions(req, "context-sync"),
        ));
        break;
      }
      case "terminus/v2/intervene": {
        const p = publicParams(req.params ?? {});
        const input = V2_ENDPOINTS.ProposeInterventionV2.request.parse({
          ...p,
          actorPrincipal: typeof p.actorPrincipal === "string" ? p.actorPrincipal : "ide-operator",
          targetEntityId: p.targetEntityId ?? null,
          payload: p.payload ?? {},
        });
        respond(id, await publicClient().proposeInterventionV2(
          input,
          mutationOptions(req, "propose-intervention"),
        ));
        break;
      }
      case "terminus/v2/attentionAssess": {
        const taskId = requiredStringParam(req.params, "taskId");
        respond(id, await publicClient().assessTaskAttentionV2(taskId));
        break;
      }
      case "terminus/v2/questions": {
        const p = req.params === undefined ? {} : publicParams(req.params);
        const parsed = V2_ENDPOINTS.ListMaterialQuestionsV2.request.parse(p);
        respond(id, await publicClient().listMaterialQuestionsV2(parsed?.taskId));
        break;
      }
      case "terminus/v2/resolveQuestion": {
        const p = V2_ENDPOINTS.ResolveMaterialQuestionV2.request.parse(
          publicParams(req.params ?? {}),
        );
        respond(id, await publicClient().resolveMaterialQuestionV2(
          p.id,
          p.selectedOption,
          mutationOptions(req, "resolve-question"),
        ));
        break;
      }
      case "terminus/v2/replay": {
        const taskId = requiredStringParam(req.params, "taskId");
        respond(id, await publicClient().getCausalTraceV2(taskId));
        break;
      }
      default:
        respondError(id, -32601, `method not found: ${req.method}`);
    }
  } catch (e) {
    respondError(id, -32603, errorMessage(e));
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: JsonRpcRequest;
    try {
      const parsed: unknown = JSON.parse(line);
      req = parseJsonRpcRequest(parsed);
    } catch (e) {
      respondError(null, -32700, `parse error: ${errorMessage(e)}`);
      continue;
    }
    await handleRequest(req);
  }
}

void main();
