/**
 * @terminus/aci — Interactive Question Tool (ADR-0048).
 *
 * Implements the interactive question tool allowing agents to solicit
 * user clarification, design decisions, or option selection during turns.
 */
import { z } from "zod";
import type { ContentHash } from "@terminus/domain";
import { computeContentHash } from "@terminus/context-ir";
import type {
  ToolExecutor,
  ToolCallContext,
  ToolResult,
  ToolDefinition,
} from "./index.js";
import { okResult, errorResult } from "./index.js";

export const questionInputSchema = z.object({
  question: z.string().min(1).max(4096),
  options: z.array(z.string().min(1).max(256)).max(16).optional(),
  multiple: z.boolean().optional().default(false),
  header: z.string().max(256).optional(),
});

export type QuestionInput = z.infer<typeof questionInputSchema>;

export const questionResultSchema = z.object({
  question_id: z.string(),
  status: z.enum(["asked", "answered", "dismissed"]),
  answer: z.string().optional(),
  selected_options: z.array(z.string()).optional(),
});

export type QuestionResult = z.infer<typeof questionResultSchema>;

export interface QuestionHandler {
  ask(input: QuestionInput, ctx: ToolCallContext): Promise<QuestionResult>;
}

export class QuestionToolExecutor implements ToolExecutor<QuestionInput, QuestionResult> {
  constructor(private readonly handler?: QuestionHandler) {}

  async execute(input: QuestionInput, ctx: ToolCallContext): Promise<ToolResult<QuestionResult>> {
    const parsed = questionInputSchema.safeParse(input);
    if (!parsed.success) {
      return errorResult(
        `Invalid question input: ${parsed.error.message}`,
        ctx,
        "INVALID_ARGUMENT",
      ) as ToolResult<QuestionResult>;
    }

    if (this.handler) {
      try {
        const result = await this.handler.ask(parsed.data, ctx);
        return okResult(
          result,
          ctx,
          `Question ${result.question_id} ${result.status}`,
        );
      } catch (err) {
        return errorResult(
          `Question handler error: ${err instanceof Error ? err.message : String(err)}`,
          ctx,
          "INTERNAL_ERROR",
        ) as ToolResult<QuestionResult>;
      }
    }

    // Default: generate question record descriptor
    const questionId = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const result: QuestionResult = {
      question_id: questionId,
      status: "asked",
    };
    return okResult(
      result,
      ctx,
      `Question submitted: ${parsed.data.question.slice(0, 80)}`,
    );
  }
}

export function createQuestionToolDefinition(): ToolDefinition {
  const inputSchema = {
    type: "object",
    required: ["question"],
    properties: {
      question: { type: "string", description: "The question to ask the user." },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional fixed set of selectable options.",
      },
      multiple: { type: "boolean", description: "Whether multiple options can be selected." },
      header: { type: "string", description: "Short heading or topic for the question." },
    },
  };

  const resultSchema = {
    type: "object",
    required: ["question_id", "status"],
    properties: {
      question_id: { type: "string" },
      status: { type: "string", enum: ["asked", "answered", "dismissed"] },
      answer: { type: "string" },
      selected_options: { type: "array", items: { type: "string" } },
    },
  };

  return {
    id: "question",
    version: "1.0.0",
    summary: "Solicit interactive decision, choice, or clarification from the user (ADR-0048).",
    useWhen: [
      "A critical choice or branching path requires user direction",
      "Ambiguity in requirements cannot be resolved from codebase inspection",
    ],
    doNotUseWhen: [
      "The question can be answered by searching or reading the codebase",
      "Asking routine progress updates or trivial confirmations",
    ],
    inputSchema,
    resultSchema,
    sideEffectClass: "none",
    requiredCapabilities: [],
    trustLevel: "builtin",
    maximumModelResultBytes: 4096,
    maximumArtifactBytes: 0,
    defaultTimeoutMs: 300_000,
    policyTags: ["interactive", "user_input"],
    definitionHash: computeContentHash(JSON.stringify(inputSchema) + JSON.stringify(resultSchema)) as ContentHash,
  };
}
