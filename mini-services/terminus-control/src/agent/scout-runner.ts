/**
 * Read-only scout subagent execution (R10, harness critical path).
 *
 * The typed scout/reviewer boundary existed (orchestration §37.7) but no
 * child ever ran: flags were hard-off and nothing executed a child loop.
 *
 * This module runs ONE real child loop with fresh context:
 *  - system prompt: minimal scout authority (no parent transcript);
 *  - tools: read / grep / glob ONLY — the write/exec surface never reaches
 *    the child schema set, and execution stays kernel-mediated through the
 *    same executeStandaloneTool path as the parent;
 *  - bounded budget: small step ceiling and per-tool byte caps inherited
 *    from the standalone schemas;
 *  - typed result: claims / filesInspected / evidenceRefs, validated and
 *    size-capped, never pasting the child transcript into the parent.
 *
 * A deterministic utility ledger decides enablement over time: scouts that
 * keep returning zero cited findings disable themselves for the session
 * instead of burning tokens forever.
 */

import {
  runBoundedDelegation,
  SCOUT_TOOL_NAMES,
  ZERO_DELEGATION_USAGE,
  type DelegationAuthority,
  type DelegationBudgetLimits,
  type DelegationIdentity,
  type DelegationLoopCallInput,
  type DelegationStepAccountant,
  type DelegationTranscriptMessage,
  type DelegationUsage,
} from "./delegation-runner.js";

export const SCOUT_SYSTEM_PROMPT = [
  "You are a Terminus read-only scout. Fresh context; you see only the objective below.",
  "Mission: locate the exact code relevant to the objective so a separate implementer does not have to search.",
  "Tools: read (line-numbered, returns file_sha256). No writing, no exec, no shell-backed search.",
  "Work in a few targeted searches; then reply with your FINAL answer as a fenced json block:",
  "```json",
  '{"claims": ["..."], "files": [{"path": "...", "role": "..."}], "open_questions": ["..."]}',
  "```",
  "Claims must be specific and verifiable (file:line anchors where possible). Max 16 claims, max 32 files.",
].join("\n");

export const SCOUT_MAX_STEPS_DEFAULT = 10;

export interface ScoutToolCall {
  readonly toolName: string;
  readonly argumentsJson: string;
}

export interface ScoutStepInput {
  readonly renderedBody: unknown;
  readonly projectedText: string;
  readonly toolCalls: readonly ScoutToolCall[];
  /** Provider usage for this exact attempt; omitted only for legacy test doubles. */
  readonly usage?: Partial<DelegationUsage>;
}

/** One read-only tool dispatch; returns the model-visible result text. */
export type ScoutToolExecutor = (input: {
  readonly toolName: "read" | "grep" | "glob";
  readonly argumentsJson: string;
  readonly step?: number;
  readonly attemptId?: string;
  readonly callIndex?: number;
  readonly signal?: AbortSignal | null;
}) => Promise<{ readonly ok: boolean; readonly resultText: string }>;

export interface ScoutParsedResult {
  readonly status: "completed" | "budget_exhausted" | "cancelled" | "failed";
  readonly claims: readonly string[];
  readonly files: readonly { readonly path: string; readonly role: string }[];
  readonly openQuestions: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly filesInspected: readonly string[];
  readonly usage: DelegationUsage;
  readonly stepReceipts: readonly {
    readonly step: number;
    readonly attemptId: string;
    readonly status: "settled" | "failed" | "cancelled";
  }[];
  readonly failureReason: string | null;
}

const RESULT_JSON_PATTERN = /```json\s*([\s\S]*?)```/;

export function parseScoutResult(text: string): ScoutParsedResult | null {
  const match = RESULT_JSON_PATTERN.exec(text);
  if (match === null) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]!.trim());
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const knownFields = new Set(["claims", "files", "open_questions", "evidence_refs"]);
    if (Object.keys(record).some((key) => !knownFields.has(key))) return null;
    if (!Array.isArray(record.claims) || !record.claims.every((claim) => typeof claim === "string")) return null;
    const claims = record.claims.slice(0, 16) as string[];
    if (claims.some((claim) => claim.trim() === "")) return null;
    const rawFiles = Array.isArray(record.files) ? record.files : [];
    if (!rawFiles.every((entry) => typeof entry === "string"
      || (typeof entry === "object" && entry !== null
        && typeof (entry as Record<string, unknown>).path === "string"
        && ((entry as Record<string, unknown>).role === undefined
          || typeof (entry as Record<string, unknown>).role === "string")))) return null;
    const files = rawFiles.map((entry) => {
      if (typeof entry === "string") return { path: entry.slice(0, 1_024), role: "" };
      const rec = entry as Record<string, unknown>;
      return {
        path: (rec.path as string).slice(0, 1_024),
        role: typeof rec.role === "string" ? rec.role.slice(0, 256) : "",
      };
    }).slice(0, 32);
    if (files.some((file) => file.path.trim() === "")) return null;
    if (!Array.isArray(record.open_questions)
      || !record.open_questions.every((question) => typeof question === "string")) return null;
    const openQuestions = record.open_questions.slice(0, 8) as string[];
    if (openQuestions.some((question) => question.trim() === "")) return null;
    if (record.evidence_refs !== undefined
      && (!Array.isArray(record.evidence_refs)
        || !record.evidence_refs.every((ref) => typeof ref === "string"))) return null;
    const evidenceRefs = (record.evidence_refs === undefined ? [] : record.evidence_refs.slice(0, 32)) as string[];
    if (evidenceRefs.some((ref) => ref.trim() === "")) return null;
    if (claims.length === 0 && files.length === 0) return null;
    return {
      status: "completed",
      claims,
      files,
      openQuestions,
      evidenceRefs,
      filesInspected: files.map((file) => file.path),
      usage: ZERO_DELEGATION_USAGE,
      stepReceipts: [],
      failureReason: null,
    };
  } catch {
    return null;
  }
}

export interface ScoutLoopDeps {
  /**
   * The task objective the scout is locating code for. Delivered as its own
   * user message so the system prompt stays a stable cache prefix.
   */
  readonly objective: string;
  /** Build one provider request for [system, messages] and execute it. */
  readonly callProvider: (
    messages: readonly DelegationTranscriptMessage[],
    context: Omit<DelegationLoopCallInput, "messages">,
  ) => Promise<ScoutStepInput>;
  /** Dispatch one read-only tool through the kernel boundary. */
  readonly executeTool: ScoutToolExecutor;
  readonly maxSteps?: number;
  readonly signal?: AbortSignal | null;
  /** Explicit identity and durable accounting for production callers. */
  readonly identity?: DelegationIdentity;
  readonly authority?: DelegationAuthority;
  readonly budget?: Partial<DelegationBudgetLimits>;
  readonly accountant?: DelegationStepAccountant;
  readonly deadlineAtMs?: number;
  /** Reject model-authored files/claims that lack observed evidence. */
  readonly validateFinalResult?: (result: ScoutParsedResult) => string | null;
}

/**
 * Run the bounded scout loop. Tool results are fed back as user-role
 * transcripts (the same shape the main loop settles); the loop ends when a
 * response carries no parsable tool calls or the final JSON block appears.
 */
export async function runScoutLoop(deps: ScoutLoopDeps): Promise<ScoutParsedResult> {
  const identity = deps.identity ?? {
    parentTaskId: "legacy-scout-parent",
    delegationId: `legacy-scout:${stableObjectiveId(deps.objective)}`,
    attemptIdForStep: (step: number) => `legacy-scout:${stableObjectiveId(deps.objective)}:attempt:${step}`,
  };
  const authority = deps.authority ?? {
    // The safe default is read-only file inspection. Shell-backed grep/glob
    // must never become ambient just because a caller omitted authority.
    allowedTools: ["read"],
    allowedReadPaths: ["**"],
    allowedWritePaths: [],
    deniedEffects: ["write", "execute", "external_effect"],
  } satisfies DelegationAuthority;
  const budget = {
    maxSteps: deps.maxSteps ?? SCOUT_MAX_STEPS_DEFAULT,
    maxTokens: null,
    maxCostMicros: null,
    ...deps.budget,
  } satisfies DelegationBudgetLimits;
  const loop = await runBoundedDelegation({
    identity,
    authority,
    budget,
    initialMessages: [
      { role: "user", text: SCOUT_SYSTEM_PROMPT },
      { role: "user", text: deps.objective },
    ],
    acceptsFinalResponse: (text) => parseScoutResult(text) !== null,
    ...(deps.accountant === undefined ? {} : { accountant: deps.accountant }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(deps.deadlineAtMs === undefined ? {} : { deadlineAtMs: deps.deadlineAtMs }),
    callProvider: async ({ messages, ...context }) => {
      const response = await deps.callProvider(messages, context);
      return {
        projectedText: response.projectedText,
        toolCalls: response.toolCalls,
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      };
    },
    validateFinalResult: (text) => {
      const parsed = parseScoutResult(text);
      if (parsed === null) return "invalid or empty scout result";
      return deps.validateFinalResult?.(parsed) ?? null;
    },
    executeTool: async ({ toolName, argumentsJson, step, attemptId, callIndex, signal }) => deps.executeTool({
      toolName,
      argumentsJson,
      step,
      attemptId,
      callIndex,
      signal,
    }),
  });
  const parsed = loop.finalText === null ? null : parseScoutResult(loop.finalText);
  const receipts = loop.stepReceipts.map(({ step, attemptId, status }) => ({ step, attemptId, status }));
  if (loop.status !== "completed" || parsed === null) {
    return {
      status: loop.status === "completed" ? "failed" : loop.status,
      claims: [],
      files: [],
      openQuestions: [],
      evidenceRefs: [],
      filesInspected: [],
      usage: loop.usage,
      stepReceipts: receipts,
      failureReason: loop.failureReason ?? (parsed === null ? "invalid or empty scout result" : null),
    };
  }
  return {
    ...parsed,
    usage: loop.usage,
    stepReceipts: receipts,
    failureReason: null,
  };
}

function stableObjectiveId(objective: string): string {
  let hash = 2_166_136_261;
  for (const character of objective) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ────────────────────────── utility ledger ──────────────────────────────────

export interface ScoutLedgerEntry {
  readonly taskId: string;
  readonly findingsCount: number;
  citedCount: number;
}

/**
 * Rolling-session ledger deciding whether scouts keep earning their tokens.
 * A scout is USEFUL when its listed files later appear in parent episodes
 * (citation) or it produced claims at all; three consecutive zero-yield
 * scouts trip the auto-disable for the process lifetime.
 */
export class ScoutUtilityLedger {
  private consecutiveZeroYield = 0;
  private disabled = false;
  private readonly entries: ScoutLedgerEntry[] = [];

  constructor(private readonly zeroYieldThreshold = 3) {}

  recordScout(taskId: string, findingsCount: number): void {
    this.entries.push({ taskId, findingsCount, citedCount: 0 });
    if (findingsCount === 0) {
      this.consecutiveZeroYield += 1;
      if (this.consecutiveZeroYield >= this.zeroYieldThreshold) this.disabled = true;
    } else {
      this.consecutiveZeroYield = 0;
    }
  }

  recordCitation(taskId: string): void {
    const last = [...this.entries].reverse().find((entry) => entry.taskId === taskId);
    if (last !== undefined) last.citedCount += 1;
  }

  shouldRun(): boolean {
    return !this.disabled;
  }

  snapshot(): { totalScouts: number; disabled: boolean; consecutiveZeroYield: number } {
    return {
      totalScouts: this.entries.length,
      disabled: this.disabled,
      consecutiveZeroYield: this.consecutiveZeroYield,
    };
  }
}

/** Feature resolution: default OFF; only an explicit "1" enables the scout. */
export function resolveScoutEnabled(raw: string | undefined | null): boolean {
  return raw?.trim() === "1";
}
