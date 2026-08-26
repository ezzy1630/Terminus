import { describe, expect, test } from "bun:test";
import type { Uuid7 } from "@terminus/domain";
import {
  QuestionToolExecutor,
  createQuestionToolDefinition,
  questionInputSchema,
  type QuestionHandler,
} from "./question.js";
import type { ToolCallContext } from "./index.js";

function fakeUuid(n: number): Uuid7 {
  const tail = n.toString(16).padStart(12, "0");
  return `018f0000-0000-7000-8000-${tail}` as Uuid7;
}

function mkCtx(): ToolCallContext {
  return {
    toolCallId: "tc-1",
    traceId: "trace-1",
    sessionId: fakeUuid(1),
    taskId: fakeUuid(2),
    turnId: fakeUuid(3),
    workspaceId: fakeUuid(4),
    actorId: "actor-1",
    capabilityToken: null,
    policyDecisionId: null,
    signal: null,
    deadlineMs: null,
  };
}

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
      mkCtx(),
    );
    expect(result.status).toBe("success");
    expect(result.data?.status).toBe("asked");
    expect(result.data?.question_id.startsWith("q-")).toBe(true);
  });

  test("custom handler returns answered result", async () => {
    const handler: QuestionHandler = {
      async ask(_input, _ctx) {
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
      mkCtx(),
    );
    expect(result.status).toBe("success");
    expect(result.data?.status).toBe("answered");
    expect(result.data?.answer).toBe("PostgreSQL");
  });

  test("definition satisfies tool contract", () => {
    const def = createQuestionToolDefinition();
    expect(def.id).toBe("question");
    expect(def.sideEffectClass).toBe("none");
    expect(def.trustLevel).toBe("builtin");
    expect(def.definitionHash).toBeDefined();
  });
});
