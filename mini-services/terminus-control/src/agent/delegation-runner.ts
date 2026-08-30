/**
 * Bounded, accounted model-callable delegation.
 *
 * The runner owns the provider-step lifecycle. A caller can supply durable
 * accounting, but cannot receive a completed result without every provider
 * step having a deterministic id and a settlement receipt.
 */

export const SCOUT_TOOL_NAMES = ["read", "grep", "glob"] as const;
export type ScoutToolName = (typeof SCOUT_TOOL_NAMES)[number];

export interface DelegationIdentity {
  readonly parentTaskId: string;
  readonly delegationId: string;
  /** Must be deterministic and unique for every step in this delegation. */
  readonly attemptIdForStep: (step: number) => string;
}

export interface DelegationAuthority {
  readonly allowedTools: readonly ScoutToolName[];
  readonly allowedReadPaths: readonly string[];
  readonly allowedWritePaths: readonly [];
  readonly deniedEffects: readonly string[];
}

export interface DelegationBudgetLimits {
  readonly maxSteps: number;
  readonly maxTokens: bigint | null;
  readonly maxCostMicros: bigint | null;
}

export interface DelegationUsage {
  readonly inputTokens: bigint;
  readonly cachedInputTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly outputTokens: bigint;
  readonly reasoningTokens: bigint;
  readonly toolSchemaTokens: bigint;
  readonly costMicros: bigint;
}

export const ZERO_DELEGATION_USAGE: DelegationUsage = Object.freeze({
  inputTokens: 0n,
  cachedInputTokens: 0n,
  cacheWriteTokens: 0n,
  outputTokens: 0n,
  reasoningTokens: 0n,
  toolSchemaTokens: 0n,
  costMicros: 0n,
});

export type DelegationStepStatus = "settled" | "failed" | "cancelled";

export interface DelegationStepReceipt {
  readonly step: number;
  readonly attemptId: string;
  readonly status: DelegationStepStatus;
  readonly usage: DelegationUsage;
  readonly failureReason: string | null;
}

export interface DelegationStepStart {
  readonly parentTaskId: string;
  readonly delegationId: string;
  readonly step: number;
  readonly attemptId: string;
}

export interface DelegationStepSettlement extends DelegationStepStart {
  readonly status: DelegationStepStatus;
  readonly usage: DelegationUsage;
  readonly failureReason: string | null;
}

/** Durable implementations should map these calls to provider attempts/events. */
export interface DelegationStepAccountant {
  readonly startStep: (input: DelegationStepStart) => Promise<void>;
  readonly settleStep: (input: DelegationStepSettlement) => Promise<void>;
}

export interface DelegationProviderToolCall {
  readonly toolName: string;
  readonly argumentsJson: string;
  /** Provider-native id. Legacy test doubles may omit it; the runner then
   * assigns a deterministic id before the call can enter the transcript. */
  readonly providerCallId?: string;
}

export type DelegationMessageRole = "user" | "assistant" | "tool";

/**
 * Canonical child transcript. Tool calls/results retain their provider ids so
 * provider renderers can reconstruct the provider's required wire roles after
 * a restart; a flattened "tool output" user message is not equivalent.
 */
export interface DelegationTranscriptMessage {
  readonly role: DelegationMessageRole;
  readonly text: string;
  readonly providerCallId?: string;
  readonly toolName?: string;
}

export interface DelegationProviderStep {
  readonly projectedText: string;
  readonly toolCalls: readonly DelegationProviderToolCall[];
  readonly usage?: Partial<DelegationUsage>;
}

export interface DelegationLoopCallInput {
  readonly step: number;
  readonly attemptId: string;
  readonly messages: readonly DelegationTranscriptMessage[];
  readonly authority: DelegationAuthority;
  readonly signal: AbortSignal | null;
}

export interface DelegationToolInput {
  readonly toolName: ScoutToolName;
  readonly argumentsJson: string;
  readonly step: number;
  readonly attemptId: string;
  readonly callIndex: number;
  readonly signal: AbortSignal | null;
}

export interface DelegationLoopDeps {
  readonly identity: DelegationIdentity;
  readonly authority: DelegationAuthority;
  readonly budget: DelegationBudgetLimits;
  readonly initialMessages?: readonly DelegationTranscriptMessage[];
  /** A monotonic wall-clock deadline for this child, when one is available. */
  readonly deadlineAtMs?: number;
  /** Validate model-authored claims against observed durable evidence. */
  readonly validateFinalResult?: (text: string) => string | null;
  /** A child-specific parser may reject a no-tool response and request one more bounded turn. */
  readonly acceptsFinalResponse?: (text: string) => boolean;
  readonly callProvider: (input: DelegationLoopCallInput) => Promise<DelegationProviderStep>;
  readonly executeTool: (input: DelegationToolInput) => Promise<{ readonly ok: boolean; readonly resultText: string }>;
  readonly accountant?: DelegationStepAccountant;
  readonly signal?: AbortSignal | null;
}

export type DelegationLoopStatus = "completed" | "budget_exhausted" | "cancelled" | "failed";

export interface DelegationLoopResult {
  readonly status: DelegationLoopStatus;
  readonly finalText: string | null;
  readonly usage: DelegationUsage;
  readonly stepReceipts: readonly DelegationStepReceipt[];
  readonly failureReason: string | null;
}

const USAGE_KEYS: readonly (keyof DelegationUsage)[] = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningTokens",
  "toolSchemaTokens",
  "costMicros",
];

function requireId(label: string, value: string): string {
  if (value.trim() === "") throw new Error(`${label} must not be blank`);
  return value;
}

function validateBudget(budget: DelegationBudgetLimits): void {
  if (!Number.isSafeInteger(budget.maxSteps) || budget.maxSteps <= 0) {
    throw new Error("delegation maxSteps must be a positive safe integer");
  }
  for (const [label, value] of [
    ["maxTokens", budget.maxTokens],
    ["maxCostMicros", budget.maxCostMicros],
  ] as const) {
    if (value !== null && value < 0n) throw new Error(`delegation ${label} must be non-negative`);
  }
}

function validateDeadline(deadlineAtMs: number | undefined): void {
  if (deadlineAtMs !== undefined && (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= 0)) {
    throw new Error("delegation deadline must be a positive finite timestamp");
  }
}

function usageFrom(raw: Partial<DelegationUsage> | undefined): DelegationUsage {
  const usage = { ...ZERO_DELEGATION_USAGE };
  if (raw === undefined) return usage;
  for (const key of USAGE_KEYS) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== "bigint" || value < 0n) {
        throw new Error(`delegation usage ${key} must be a non-negative bigint`);
      }
      usage[key] = value;
    }
  }
  return usage;
}

function addUsage(left: DelegationUsage, right: DelegationUsage): DelegationUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    toolSchemaTokens: left.toolSchemaTokens + right.toolSchemaTokens,
    costMicros: left.costMicros + right.costMicros,
  };
}

function budgetTokens(usage: DelegationUsage): bigint {
  return usage.inputTokens
    + usage.cacheWriteTokens
    + usage.outputTokens
    + usage.reasoningTokens
    + usage.toolSchemaTokens;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

function isAborted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true;
}

function abortError(): Error {
  return new Error("delegation cancelled");
}

async function withCancellation<T>(
  work: Promise<T>,
  signal: AbortSignal | null | undefined,
): Promise<T> {
  if (signal === null || signal === undefined) return work;
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | null = null;
  let aborted = false;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => {
      aborted = true;
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const completion = Promise.resolve(work);
  try {
    return await Promise.race([completion, cancellation]);
  } catch (error) {
    // A cancellation race must not settle the durable attempt while the
    // provider/tool still runs. Wait for the underlying promise to finish;
    // the caller still receives cancellation, but paid work has a terminal
    // observation before its receipt is written.
    if (aborted) {
      try {
        await completion;
      } catch {
        // The cancellation is the authoritative outcome for this attempt.
      }
      throw abortError();
    }
    throw error;
  } finally {
    if (onAbort !== null) signal.removeEventListener("abort", onAbort);
  }
}

function validateProviderStep(step: DelegationProviderStep): void {
  if (typeof step.projectedText !== "string" || !Array.isArray(step.toolCalls)) {
    throw new Error("delegation provider returned an invalid step");
  }
  for (const call of step.toolCalls) {
    if (typeof call !== "object" || call === null
      || typeof call.toolName !== "string"
      || typeof call.argumentsJson !== "string") {
      throw new Error("delegation provider returned an invalid tool call");
    }
    if (call.providerCallId !== undefined && call.providerCallId.trim() === "") {
      throw new Error("delegation provider returned a blank tool call id");
    }
  }
}

function pathAllowed(path: string, allowedPaths: readonly string[]): boolean {
  if (allowedPaths.includes("**")) return true;
  return allowedPaths.some((pattern) => {
    if (pattern === path) return true;
    if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -3));
    return false;
  });
}

function toolPath(toolName: string, argumentsJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const path = (parsed as Record<string, unknown>).path;
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}

function canonicalToolCall(call: DelegationProviderToolCall, providerCallId: string): string {
  return JSON.stringify({
    protocol: "terminus.tool-call.v1",
    provider_call_id: providerCallId,
    tool_name: call.toolName,
    arguments: JSON.parse(call.argumentsJson) as unknown,
  });
}

function canonicalToolResult(providerCallId: string, toolName: string, resultText: string): string {
  return JSON.stringify({
    protocol: "terminus.tool-result.v1",
    provider_call_id: providerCallId,
    tool_name: toolName,
    result: resultText,
  });
}

const DELEGATION_TOOL_RESULT_MAX_CHARS = 48_000;

function toolIsAllowed(authority: DelegationAuthority, name: string): name is ScoutToolName {
  return (SCOUT_TOOL_NAMES as readonly string[]).includes(name)
    && authority.allowedTools.includes(name as ScoutToolName);
}

/** In-memory evidence for tests and non-durable callers. */
export class InMemoryDelegationStepAccountant implements DelegationStepAccountant {
  readonly starts: DelegationStepStart[] = [];
  readonly settlements: DelegationStepSettlement[] = [];

  async startStep(input: DelegationStepStart): Promise<void> {
    this.starts.push(input);
  }

  async settleStep(input: DelegationStepSettlement): Promise<void> {
    this.settlements.push(input);
  }
}

/**
 * Run one child conversation. Every provider response, including failures and
 * cancellation, is settled before this function can return.
 */
export async function runBoundedDelegation(
  deps: DelegationLoopDeps,
): Promise<DelegationLoopResult> {
  requireId("delegation parentTaskId", deps.identity.parentTaskId);
  requireId("delegation delegationId", deps.identity.delegationId);
  validateBudget(deps.budget);
  validateDeadline(deps.deadlineAtMs);
  if (deps.authority.allowedWritePaths.length !== 0) {
    throw new Error("delegation authority may not contain write paths");
  }

  const accountant = deps.accountant ?? new InMemoryDelegationStepAccountant();
  const receipts: DelegationStepReceipt[] = [];
  let totalUsage = ZERO_DELEGATION_USAGE;
  const transcript: DelegationTranscriptMessage[] = [...(deps.initialMessages ?? [])];
  const seenProviderCallIds = new Set<string>();
  let finalText: string | null = null;
  let failureReason: string | null = null;
  let status: DelegationLoopStatus = "budget_exhausted";

  for (let step = 0; step < deps.budget.maxSteps; step += 1) {
    if (isAborted(deps.signal)) {
      status = "cancelled";
      failureReason = "delegation cancelled";
      break;
    }
    if (deps.budget.maxTokens === 0n || deps.budget.maxCostMicros === 0n) {
      status = "budget_exhausted";
      failureReason = "delegation has no provider budget remaining";
      break;
    }
    if (deps.deadlineAtMs !== undefined && Date.now() >= deps.deadlineAtMs) {
      status = "budget_exhausted";
      failureReason = "delegation deadline exhausted";
      break;
    }
    const attemptId = requireId(
      `delegation attempt id for step ${step}`,
      deps.identity.attemptIdForStep(step),
    );
    if (receipts.some((receipt) => receipt.attemptId === attemptId)) {
      status = "failed";
      failureReason = `duplicate delegation attempt id: ${attemptId}`;
      break;
    }
    const start: DelegationStepStart = {
      parentTaskId: deps.identity.parentTaskId,
      delegationId: deps.identity.delegationId,
      step,
      attemptId,
    };
    try {
      await accountant.startStep(start);
    } catch (error) {
      status = "failed";
      failureReason = `step accounting start failed: ${errorText(error)}`;
      break;
    }

    let stepUsage = ZERO_DELEGATION_USAGE;
    let stepStatus: DelegationStepStatus = "settled";
    let stepFailure: string | null = null;
    try {
      const response = await withCancellation(deps.callProvider({
        step,
        attemptId,
        messages: transcript,
        authority: deps.authority,
        signal: deps.signal ?? null,
      }), deps.signal);
      validateProviderStep(response);
      stepUsage = usageFrom(response.usage);
      totalUsage = addUsage(totalUsage, stepUsage);
      if (deps.deadlineAtMs !== undefined && Date.now() >= deps.deadlineAtMs) {
        stepStatus = "failed";
        stepFailure = "delegation deadline exhausted";
        status = "budget_exhausted";
      } else if ((deps.budget.maxTokens !== null && budgetTokens(totalUsage) > deps.budget.maxTokens)
        || (deps.budget.maxCostMicros !== null && totalUsage.costMicros > deps.budget.maxCostMicros)) {
        stepStatus = "failed";
        stepFailure = "delegation budget exhausted";
        status = "budget_exhausted";
      } else {
        const duplicateProviderCall = response.toolCalls
          .map((call, callIndex) => call.providerCallId ?? `${attemptId}:tool:${callIndex}`)
          .find((providerCallId, index, ids) => ids.indexOf(providerCallId) !== index
            || seenProviderCallIds.has(providerCallId));
        const invalidTool = response.toolCalls.find((call) => {
          if (!toolIsAllowed(deps.authority, call.toolName)) return true;
          const path = toolPath(call.toolName, call.argumentsJson);
          return path !== null && !pathAllowed(path, deps.authority.allowedReadPaths);
        });
        if (duplicateProviderCall !== undefined) {
          stepStatus = "failed";
          stepFailure = `duplicate provider tool call id: ${duplicateProviderCall}`;
          status = "failed";
        } else if (invalidTool !== undefined) {
          stepStatus = "failed";
          const path = toolPath(invalidTool.toolName, invalidTool.argumentsJson);
          stepFailure = path !== null && !pathAllowed(path, deps.authority.allowedReadPaths)
            ? `tool '${invalidTool.toolName}' path '${path}' is outside delegation read scope`
            : `tool '${invalidTool.toolName}' is not available to this delegation`;
          status = "failed";
        } else if (response.toolCalls.length === 0) {
          if (deps.acceptsFinalResponse?.(response.projectedText) === false) {
            transcript.push({ role: "assistant", text: response.projectedText });
            transcript.push({ role: "user", text: "Reply now with the final ```json``` block." });
          } else {
            finalText = response.projectedText;
            status = "completed";
          }
        } else {
          if (response.projectedText.length > 0) {
            transcript.push({ role: "assistant", text: response.projectedText });
          }
          for (const [callIndex, call] of response.toolCalls.entries()) {
            const providerCallId = call.providerCallId ?? `${attemptId}:tool:${callIndex}`;
            seenProviderCallIds.add(providerCallId);
            const callTranscript = canonicalToolCall(call, providerCallId);
            transcript.push({
              role: "assistant",
              text: callTranscript,
              providerCallId,
              toolName: call.toolName,
            });
            const toolName = call.toolName as ScoutToolName;
            try {
              const result = await withCancellation(deps.executeTool({
                toolName,
                argumentsJson: call.argumentsJson,
                step,
                attemptId,
                callIndex,
                signal: deps.signal ?? null,
              }), deps.signal);
              if (result.resultText.length > DELEGATION_TOOL_RESULT_MAX_CHARS) {
                throw new Error(
                  `tool '${toolName}' result exceeded ${DELEGATION_TOOL_RESULT_MAX_CHARS} characters; provide an artifact or continuation`,
                );
              }
              const resultTranscript = canonicalToolResult(providerCallId, toolName, result.resultText);
              transcript.push({
                role: "tool",
                text: resultTranscript,
                providerCallId,
                toolName,
              });
            } catch (error) {
              if (isAborted(deps.signal)) throw abortError();
              const failure = `tool ${toolName} failed: ${errorText(error)}`;
              const resultTranscript = canonicalToolResult(providerCallId, toolName, failure);
              transcript.push({
                role: "tool",
                text: resultTranscript,
                providerCallId,
                toolName,
              });
            }
          }
        }
      }
    } catch (error) {
      stepStatus = isAborted(deps.signal) || errorText(error) === "delegation cancelled"
        ? "cancelled"
        : "failed";
      stepFailure = errorText(error);
      status = stepStatus === "cancelled" ? "cancelled" : "failed";
    }

    const settlement: DelegationStepSettlement = { ...start, status: stepStatus, usage: stepUsage, failureReason: stepFailure };
    try {
      await accountant.settleStep(settlement);
    } catch (error) {
      status = "failed";
      failureReason = `step accounting settlement failed: ${errorText(error)}`;
      receipts.push({ ...settlement });
      break;
    }
    receipts.push({ ...settlement });
    if (stepFailure !== null) failureReason = stepFailure;
    if (stepStatus !== "settled" || finalText !== null) break;
  }

  if (status === "budget_exhausted" && receipts.length >= deps.budget.maxSteps) {
    failureReason = failureReason ?? "delegation step budget exhausted";
  }
  if (status === "completed" && finalText === null) {
    status = "failed";
    failureReason = "delegation completed without a final response";
  }
  if (status === "completed" && finalText !== null && deps.validateFinalResult !== undefined) {
    const validationFailure = deps.validateFinalResult(finalText);
    if (validationFailure !== null) {
      status = "failed";
      failureReason = validationFailure;
      finalText = null;
    }
  }
  return { status, finalText, usage: totalUsage, stepReceipts: receipts, failureReason };
}
