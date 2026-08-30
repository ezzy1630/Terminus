import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_INITIAL_CONTENTS = "Terminus deterministic read fixture.\n";
const DEFAULT_FINAL_CONTENTS = "Terminus deterministic patched fixture.\n";
const DEFAULT_FIXTURE_NAME = "e2e-fixture.txt";
const RENDERER_EVAL_TIMEOUT_MS = 45_000;

interface DevToolsTargetRecord {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export interface DeterministicDesktopTaskOptions {
  readonly workspaceRoot: string;
  readonly providerScriptSource: string;
  readonly providerRuntime: string;
  readonly fixtureName?: string;
  readonly initialContents?: string;
  readonly finalContents?: string;
}

export interface DeterministicDesktopTaskEvidence {
  readonly schema: "terminus.desktop-runtime.task.v1";
  readonly workspace_root: string;
  readonly fixture_path: string;
  readonly initial_sha256: string;
  readonly final_sha256: string;
  readonly task_id: string;
  readonly turn_id: string;
  readonly provider_attempt_id: string;
  readonly context_manifest_id: string;
  readonly verification_plan_id: string;
  readonly completion_record_id: string;
  readonly completion_event_id: string;
  readonly task_status: "COMPLETED";
  readonly turn_state: "COMPLETED";
  readonly verification_passed: true;
  readonly renderer_auth_boundary: "main-process-injected";
  readonly provider: "deterministic-local-stdio-fixture";
}

interface RendererTaskResult {
  readonly task_id: string;
  readonly turn_id: string;
  readonly provider_attempt_id: string;
  readonly context_manifest_id: string;
  readonly verification_plan_id: string;
  readonly completion_record_id: string;
  readonly completion_event_id: string;
  readonly task_status: "COMPLETED";
  readonly turn_state: "COMPLETED";
}

function record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0)
    throw new Error(`${label}.${key} must be a non-empty string`);
  return field;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

/** Parse the bounded `/json/list` response without trusting its shape. */
export function parseDevToolsTargets(
  value: unknown,
): readonly DevToolsTargetRecord[] {
  if (!Array.isArray(value))
    throw new Error("DevTools target list must be an array");
  return value.map((item, index) => {
    const target = record(item, `DevTools target ${index}`);
    const type = stringField(target, "type", `DevTools target ${index}`);
    const url = stringField(target, "url", `DevTools target ${index}`);
    const webSocketDebuggerUrl = stringField(
      target,
      "webSocketDebuggerUrl",
      `DevTools target ${index}`,
    );
    if (
      !webSocketDebuggerUrl.startsWith("ws://127.0.0.1:") &&
      !webSocketDebuggerUrl.startsWith("ws://localhost:")
    ) {
      throw new Error(`DevTools target ${index} is not loopback-bound`);
    }
    return { type, url, webSocketDebuggerUrl };
  });
}

async function evaluateRenderer(
  webSocketUrl: string,
  expression: string,
): Promise<unknown> {
  const socket = new WebSocket(webSocketUrl);
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(
        new Error(
          `renderer evaluation timed out after ${RENDERER_EVAL_TIMEOUT_MS}ms`,
        ),
      );
    }, RENDERER_EVAL_TIMEOUT_MS);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
      socket.close();
    };
    socket.onerror = () =>
      finish(() => reject(new Error("renderer DevTools connection failed")));
    socket.onclose = () =>
      finish(() => reject(new Error("renderer DevTools connection closed")));
    socket.onmessage = (event: MessageEvent): void => {
      if (typeof event.data !== "string") {
        finish(() =>
          reject(new Error("renderer DevTools returned a non-text response")),
        );
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(event.data) as unknown;
      } catch {
        finish(() =>
          reject(new Error("renderer DevTools returned invalid JSON")),
        );
        return;
      }
      const response = record(message, "renderer DevTools response");
      if (response.id !== 1) return;
      if (response.error !== undefined) {
        finish(() =>
          reject(
            new Error(
              `renderer evaluation failed: ${jsonText(response.error)}`,
            ),
          ),
        );
        return;
      }
      const result = record(response.result, "renderer evaluation result");
      if (result.exceptionDetails !== undefined) {
        const details = record(
          result.exceptionDetails,
          "renderer evaluation exception",
        );
        const exception = typeof details.exception === "object"
          && details.exception !== null
          && !Array.isArray(details.exception)
          ? details.exception as Readonly<Record<string, unknown>>
          : null;
        const description = typeof exception?.description === "string"
          ? exception.description
          : typeof details.text === "string"
            ? details.text
            : jsonText(details);
        finish(() =>
          reject(new Error(`renderer evaluation threw: ${description}`)),
        );
        return;
      }
      const remoteObject = record(
        result.result,
        "renderer evaluation remote result",
      );
      if (remoteObject.value === undefined) {
        finish(() =>
          reject(new Error("renderer evaluation returned no value")),
        );
        return;
      }
      finish(() => resolve(remoteObject.value));
    };
    socket.onopen = (): void => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    };
  });
}

async function fetchRendererTargets(
  port: number,
): Promise<readonly DevToolsTargetRecord[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok)
    throw new Error(`DevTools target listing returned HTTP ${response.status}`);
  return parseDevToolsTargets((await response.json()) as unknown);
}

export async function findPackagedRendererTarget(
  port: number,
  timeoutMs: number,
): Promise<DevToolsTargetRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no packaged renderer target was advertised";
  while (Date.now() < deadline) {
    try {
      const target = (await fetchRendererTargets(port)).find(
        (candidate) =>
          candidate.type === "page" &&
          candidate.url.startsWith("terminus://app/"),
      );
      if (target !== undefined) return target;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  throw new Error(
    `packaged renderer DevTools target unavailable: ${lastError}`,
  );
}

function rendererTaskExpression(
  workspaceUri: string,
  fixtureName: string,
): string {
  return `
    (async () => {
      const apiBase = window.terminusDesktop?.apiBase;
      if (typeof apiBase !== "string" || apiBase.length === 0) throw new Error("renderer has no control origin");
      let mutationSequence = 0;
      const request = async (path, init = {}) => {
        const method = String(init.method || "GET").toUpperCase();
        const mutationHeaders = method === "GET" || method === "HEAD"
          ? {}
          : { "idempotency-key": "desktop-proof-" + (++mutationSequence) + "-" + crypto.randomUUID() };
        const response = await fetch(apiBase + path, {
          ...init,
          headers: { "content-type": "application/json", ...mutationHeaders, ...(init.headers || {}) },
        });
        const text = await response.text();
        let body = {};
        try { body = text.length === 0 ? {} : JSON.parse(text); } catch { throw new Error("control response was not JSON"); }
        if (!response.ok) throw new Error("control request " + path + " failed (" + response.status + "): " + text.slice(-500));
        return body;
      };
      const workspace = await request("/v1/workspaces/open", {
        method: "POST",
        body: JSON.stringify({ root_uri: ${JSON.stringify(workspaceUri)}, kind: "local_directory", trust: "trusted", policy_profile_id: "secure-local-default" }),
      });
      if (typeof workspace.id !== "string") throw new Error("workspace open did not return an id");
      const session = await request("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ workspace_id: workspace.id, title: "Packaged deterministic task", default_permission_profile: "secure-local-default" }),
      });
      if (typeof session.id !== "string" || typeof session.active_thread_id !== "string") throw new Error("session creation did not return identity");
      const task = await request("/v1/tasks", {
        method: "POST",
        body: JSON.stringify({
          session_id: session.id,
          thread_id: session.active_thread_id,
          objective: "exercise packaged desktop deterministic task",
          non_goals: ["external side effects"],
          acceptance_criteria: [{ id: "packaged-fixture", statement: "The packaged renderer task changes and verifies the scoped fixture.", verification_hint: "command:/bin/ls -d .", required: true }],
          allowed_scope: { read_paths: [".", ${JSON.stringify(fixtureName)}], write_paths: [${JSON.stringify(fixtureName)}], external_systems: [] },
        }),
      });
      if (typeof task.id !== "string") throw new Error("task creation did not return an id");
      await request("/v1/tasks/" + encodeURIComponent(task.id) + "/start", { method: "POST", body: "{}" });
      const turn = await request("/v1/turns", {
        method: "POST",
        body: JSON.stringify({ thread_id: session.active_thread_id, task_id: task.id, user_input: "Complete the deterministic scoped fixture edit and verification." }),
      });
      if (typeof turn.id !== "string") throw new Error("turn creation did not return an id");
      const deadline = Date.now() + 30000;
      let finalTurn = null;
      let finalTask = null;
      while (Date.now() < deadline) {
        [finalTurn, finalTask] = await Promise.all([
          request("/v1/turns/" + encodeURIComponent(turn.id)),
          request("/v1/tasks/" + encodeURIComponent(task.id)),
        ]);
        if (
          (finalTurn.state === "COMPLETED" && finalTask.status === "COMPLETED")
          || finalTurn.state === "FAILED"
          || finalTurn.state === "CANCELLED"
        ) break;
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
      }
      if (finalTurn?.state !== "COMPLETED") throw new Error("packaged deterministic turn did not complete: " + JSON.stringify(finalTurn));
      if (finalTask?.status !== "COMPLETED") throw new Error("packaged deterministic task did not complete: " + JSON.stringify(finalTask));
      const exported = await request("/v1/system/export", { method: "POST", body: "{}" });
      const manifests = Array.isArray(exported.context_manifests) ? exported.context_manifests : [];
      const manifest = manifests.find((item) => item && item.task_id === task.id);
      const plans = Array.isArray(exported.verification_plans) ? exported.verification_plans : [];
      const plan = plans.find((item) => item && item.task_id === task.id);
      const records = Array.isArray(exported.completion_records) ? exported.completion_records : [];
      const completion = records.find((item) => item && item.task_id === task.id && item.status === "completed");
      const events = Array.isArray(exported.events) ? exported.events : [];
      const completedEvent = events.find((item) => item && item.aggregate_id === task.id && item.event_type === "task.completed");
      if (!manifest || typeof manifest.id !== "string" || typeof manifest.provider_attempt_id !== "string") throw new Error("durable context manifest evidence is missing");
      if (!plan || typeof plan.id !== "string" || !Array.isArray(plan.results) || plan.results.length === 0 || plan.results.some((item) => item.status !== "pass")) throw new Error("durable verification evidence is incomplete");
      if (!completion || typeof completion.id !== "string" || completion.verification_plan_id !== plan.id) throw new Error("durable completion record evidence is missing");
      if (!completedEvent || typeof completedEvent.event_id !== "string") throw new Error("durable task completion event is missing");
      return { task_id: task.id, turn_id: turn.id, provider_attempt_id: manifest.provider_attempt_id, context_manifest_id: manifest.id, verification_plan_id: plan.id, completion_record_id: completion.id, completion_event_id: completedEvent.event_id, task_status: finalTask.status, turn_state: finalTurn.state };
    })()
  `;
}

export async function runDeterministicDesktopTask(
  webSocketUrl: string,
  options: DeterministicDesktopTaskOptions,
): Promise<DeterministicDesktopTaskEvidence> {
  const fixtureName = options.fixtureName ?? DEFAULT_FIXTURE_NAME;
  const initialContents = options.initialContents ?? DEFAULT_INITIAL_CONTENTS;
  const finalContents = options.finalContents ?? DEFAULT_FINAL_CONTENTS;
  const fixturePath = join(options.workspaceRoot, fixtureName);
  await mkdir(options.workspaceRoot, { recursive: true, mode: 0o700 });
  await writeFile(fixturePath, initialContents, {
    encoding: "utf8",
    mode: 0o600,
  });
  const providerPath = join(
    options.workspaceRoot,
    "terminus-provider-fixture.ts",
  );
  await writeFile(providerPath, options.providerScriptSource, {
    encoding: "utf8",
    mode: 0o700,
  });
  if (options.providerRuntime.length === 0)
    throw new Error("deterministic provider runtime is empty");
  const workspaceUri = pathToFileURL(options.workspaceRoot).toString();
  const result = record(
    await evaluateRenderer(
      webSocketUrl,
      rendererTaskExpression(workspaceUri, fixtureName),
    ),
    "renderer task result",
  );
  const typed: RendererTaskResult = {
    task_id: stringField(result, "task_id", "renderer task result"),
    turn_id: stringField(result, "turn_id", "renderer task result"),
    provider_attempt_id: stringField(
      result,
      "provider_attempt_id",
      "renderer task result",
    ),
    context_manifest_id: stringField(
      result,
      "context_manifest_id",
      "renderer task result",
    ),
    verification_plan_id: stringField(
      result,
      "verification_plan_id",
      "renderer task result",
    ),
    completion_record_id: stringField(
      result,
      "completion_record_id",
      "renderer task result",
    ),
    completion_event_id: stringField(
      result,
      "completion_event_id",
      "renderer task result",
    ),
    task_status:
      result.task_status === "COMPLETED"
        ? "COMPLETED"
        : (() => {
            throw new Error("renderer task result status is not COMPLETED");
          })(),
    turn_state:
      result.turn_state === "COMPLETED"
        ? "COMPLETED"
        : (() => {
            throw new Error("renderer task result state is not COMPLETED");
          })(),
  };
  const actual = await readFile(fixturePath, "utf8");
  if (actual !== finalContents)
    throw new Error(
      `packaged deterministic task did not mutate ${fixtureName}`,
    );
  return {
    schema: "terminus.desktop-runtime.task.v1",
    workspace_root: options.workspaceRoot,
    fixture_path: fixturePath,
    initial_sha256: sha256(initialContents),
    final_sha256: sha256(actual),
    ...typed,
    task_status: "COMPLETED",
    turn_state: "COMPLETED",
    verification_passed: true,
    renderer_auth_boundary: "main-process-injected",
    provider: "deterministic-local-stdio-fixture",
  };
}

/** Copy the repository fixture source into the private disposable workspace. */
export async function readProviderFixture(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

export function deterministicProviderCommand(
  providerRuntime: string,
  providerScriptPath: string,
): string {
  return JSON.stringify({
    program: providerRuntime,
    args: [providerScriptPath],
    model: "local/e2e-model",
    timeout_seconds: 30,
    tools_enabled: true,
  });
}
