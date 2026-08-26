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

export const SCOUT_SYSTEM_PROMPT = [
  "You are a Terminus read-only scout. Fresh context; you see only the objective below.",
  "Mission: locate the exact code relevant to the objective so a separate implementer does not have to search.",
  "Tools: read (line-numbered, returns file_sha256), grep (rg), glob. No writing, no exec.",
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
}

/** One read-only tool dispatch; returns the model-visible result text. */
export type ScoutToolExecutor = (input: {
  readonly toolName: "read" | "grep" | "glob";
  readonly argumentsJson: string;
}) => Promise<{ readonly ok: boolean; readonly resultText: string }>;

export interface ScoutParsedResult {
  readonly status: "completed" | "budget_exhausted" | "failed";
  readonly claims: readonly string[];
  readonly files: readonly { readonly path: string; readonly role: string }[];
  readonly openQuestions: readonly string[];
}

const RESULT_JSON_PATTERN = /```json\s*([\s\S]*?)```/;

export function parseScoutResult(text: string): ScoutParsedResult | null {
  const match = RESULT_JSON_PATTERN.exec(text);
  if (match === null) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]!.trim());
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const claims = Array.isArray(record.claims)
      ? record.claims.filter((c): c is string => typeof c === "string").slice(0, 16)
      : [];
    const rawFiles = Array.isArray(record.files) ? record.files : [];
    const files = rawFiles
      .map((entry) => {
        if (typeof entry === "string") return { path: entry.slice(0, 1_024), role: "" };
        if (typeof entry === "object" && entry !== null) {
          const rec = entry as Record<string, unknown>;
          if (typeof rec.path === "string") {
            return {
              path: rec.path.slice(0, 1_024),
              role: typeof rec.role === "string" ? rec.role.slice(0, 256) : "",
            };
          }
        }
        return null;
      })
      .filter((entry): entry is { path: string; role: string } => entry !== null)
      .slice(0, 32);
    const openQuestions = Array.isArray(record.open_questions)
      ? record.open_questions.filter((q): q is string => typeof q === "string").slice(0, 8)
      : [];
    if (claims.length === 0 && files.length === 0) return null;
    return { status: "completed", claims, files, openQuestions };
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
  readonly callProvider: (messages: readonly { readonly role: "user" | "assistant"; readonly text: string }[]) => Promise<ScoutStepInput>;
  /** Dispatch one read-only tool through the kernel boundary. */
  readonly executeTool: ScoutToolExecutor;
  readonly maxSteps?: number;
  readonly signal?: AbortSignal | null;
}

/**
 * Run the bounded scout loop. Tool results are fed back as user-role
 * transcripts (the same shape the main loop settles); the loop ends when a
 * response carries no parsable tool calls or the final JSON block appears.
 */
export async function runScoutLoop(deps: ScoutLoopDeps): Promise<ScoutParsedResult> {
  const maxSteps = deps.maxSteps ?? SCOUT_MAX_STEPS_DEFAULT;
  const transcript: { readonly role: "user" | "assistant"; readonly text: string }[] = [
    { role: "user", text: SCOUT_SYSTEM_PROMPT },
    { role: "user", text: deps.objective },
  ];
  for (let step = 0; step < maxSteps; step += 1) {
    if (deps.signal?.aborted === true) break;
    const stepInput = await deps.callProvider(transcript);
    const parsed = parseScoutResult(stepInput.projectedText);
    if (parsed !== null && stepInput.toolCalls.length === 0) return parsed;
    if (stepInput.toolCalls.length === 0) {
      // No tools and no parsable final block: one retry with a formatting
      // demand keeps the child from silently ending empty-handed.
      transcript.push({ role: "assistant", text: stepInput.projectedText });
      transcript.push({ role: "user", text: "Reply now with the final ```json``` block." });
      continue;
    }
    const resultParts: string[] = [];
    for (const call of stepInput.toolCalls) {
      const toolName = call.toolName === "read" || call.toolName === "grep" || call.toolName === "glob"
        ? call.toolName
        : null;
      if (toolName === null) {
        resultParts.push(`tool '${call.toolName}' is not available to scouts`);
        continue;
      }
      try {
        const outcome = await deps.executeTool({ toolName, argumentsJson: call.argumentsJson });
        resultParts.push(outcome.resultText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resultParts.push(`tool ${toolName} failed: ${message.slice(0, 512)}`);
      }
    }
    transcript.push({ role: "assistant", text: stepInput.projectedText });
    transcript.push({ role: "user", text: resultParts.join("\n\n").slice(0, 48_000) });
  }
  return { status: "budget_exhausted", claims: [], files: [], openQuestions: [] };
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
