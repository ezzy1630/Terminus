import { describe, expect, test } from "bun:test";
import {
  QuestionToolExecutor,
  createQuestionToolDefinition,
  questionInputSchema,
  questionResultSchema,
  type QuestionHandler,
} from "./question.js";
import type { ToolCallContext } from "./index.js";

const mockContext: ToolCallContext = {
  toolCallId: "tc-1" as any,
  turnId: "turn-1" as any,
  traceId: "trace-1" as any,
  workspaceRoot: "/tmp/test",
  now: () => Date.now(),
};

describe("question tool", () => {
  test("validates valid question input", () => {
    const input = {
      question: "Which database adapter should we use?",
      options: ["PostgreSQL", "SQLite", "MySQL"],
      multiple: false,
      header: "Database Selection",
    };
    const parsed = questionInputSchema.safeParse(input);
    expect(parsed.success).toBe(true);
  });

  test("rejects empty question string", () => {
    const parsed = questionInputSchema.safeParse({ question: "" });
    expect(parsed.success).toBe(false);
  });

  test("default executor generates question id and returns status asked", async () => {
    const executor = new QuestionToolExecutor();
    const result = await executor.execute(
      { question: "Should we proceed?" },
      mockContext,
    );
    expect(result.status).toBe("success");
    expect(result.data.status).toBe("asked");
    expect(result.data.question_id.startsWith("q-")).toBe(true);
  });

  test("custom handler returns answered result", async () => {
    const handler: QuestionHandler = {
      async ask(input, _ctx) {
        return {
          question_id: "q-123",
          status: "answered",
          answer: "PostgreSQL",
          selected_options: ["PostgreSQL"],
        };
      },
    };
    const executor = new QuestionToolExecutor(handler);
    const result = await executor.execute(
      { question: "Which DB?", options: ["PostgreSQL", "SQLite"] },
      mockContext,
    );
    expect(result.status).toBe("success");
    expect(result.data.status).toBe("answered");
    expect(result.data.answer).toBe("PostgreSQL");
  });

  test("definition satisfies tool contract", () => {
    const def = createQuestionToolDefinition();
    expect(def.id).toBe("question");
    expect(def.sideEffectClass).toBe("none");
    expect(def.trustLevel).toBe("builtin");
    expect(def.definitionHash).toBeDefined();
  });
});
