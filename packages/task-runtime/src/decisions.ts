/**
 * @terminus/task-runtime — Questions, Decisions, Risks & Budget Management.
 *
 * Per SPEC §4.2, §29.3, §37.2, §46.9:
 * Provides durable human/model question interactions, auditable architectural decisions,
 * tracked risk mitigation lifecycles, and strictly bound budget consumption.
 */
import type {
  Question,
  Decision,
  Risk,
  BudgetConsumption,
  Rfc3339Timestamp,
} from "@terminus/domain";
import { nowTimestamp } from "@terminus/domain";
import type { DurableTaskRepository } from "./types.js";
import { TransactionalOutbox } from "./outbox.js";

export class BudgetExhaustedError extends Error {
  constructor(
    message: string,
    public readonly limitKind: string,
    public readonly consumed: string,
    public readonly limit: string,
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export class DecisionRiskBudgetManager {
  constructor(
    private readonly repo: DurableTaskRepository,
    private readonly outbox: TransactionalOutbox,
    private readonly questionIdSource: () => string = () => `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly decisionIdSource: () => string = () => `dec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly riskIdSource: () => string = () => `risk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly clock: () => Rfc3339Timestamp = () => nowTimestamp(),
  ) {}

  // ──────────────────────── Questions ──────────────────────────────────────────

  async askQuestion(
    taskId: string,
    prompt: string,
    options: readonly string[] = [],
  ): Promise<Question> {
    const now = this.clock();
    const question: Question = {
      id: this.questionIdSource(),
      taskId,
      prompt,
      options,
      selectedOption: null,
      rationale: null,
      status: "PENDING",
      createdAt: now,
      resolvedAt: null,
    };

    const outboxMsg = this.outbox.createMessage(
      "question",
      question.id,
      1,
      "question.asked",
      {
        questionId: question.id,
        taskId,
        prompt,
        options,
      },
    );

    return this.repo.createQuestion(question, outboxMsg);
  }

  async answerQuestion(
    questionId: string,
    selectedOption: string,
    rationale: string | null = null,
  ): Promise<Question> {
    const question = await this.repo.getQuestion(questionId);
    if (!question) {
      throw new Error(`Question ${questionId} not found`);
    }

    const now = this.clock();
    const updated: Question = {
      ...question,
      selectedOption,
      rationale,
      status: "ANSWERED",
      resolvedAt: now,
    };

    const outboxMsg = this.outbox.createMessage(
      "question",
      updated.id,
      2,
      "question.answered",
      {
        questionId: updated.id,
        taskId: updated.taskId,
        selectedOption,
        rationale,
      },
    );

    return this.repo.updateQuestion(updated, outboxMsg);
  }

  async dismissQuestion(questionId: string): Promise<Question> {
    const question = await this.repo.getQuestion(questionId);
    if (!question) {
      throw new Error(`Question ${questionId} not found`);
    }

    const now = this.clock();
    const updated: Question = {
      ...question,
      status: "DISMISSED",
      resolvedAt: now,
    };

    const outboxMsg = this.outbox.createMessage(
      "question",
      updated.id,
      2,
      "question.dismissed",
      {
        questionId: updated.id,
        taskId: updated.taskId,
      },
    );

    return this.repo.updateQuestion(updated, outboxMsg);
  }

  // ──────────────────────── Decisions ──────────────────────────────────────────

  async recordDecision(
    taskId: string,
    statement: string,
    rationale: string,
    provenance: string,
    options: {
      questionId?: string | null;
      alternativesConsidered?: readonly string[];
    } = {},
  ): Promise<Decision> {
    const now = this.clock();
    const decision: Decision = {
      id: this.decisionIdSource(),
      taskId,
      questionId: options.questionId ?? null,
      statement,
      alternativesConsidered: options.alternativesConsidered ?? [],
      rationale,
      provenance,
      recordedAt: now,
    };

    const outboxMsg = this.outbox.createMessage(
      "decision",
      decision.id,
      1,
      "decision.recorded",
      {
        decisionId: decision.id,
        taskId,
        questionId: decision.questionId,
        statement,
        alternativesConsidered: decision.alternativesConsidered,
        rationale,
        provenance,
      },
    );

    return this.repo.createDecision(decision, outboxMsg);
  }

  // ──────────────────────── Risks ──────────────────────────────────────────────

  async recordRisk(
    taskId: string,
    riskClass: "LOW" | "NORMAL" | "HIGH" | "CRITICAL",
    statement: string,
    mitigation: string | null = null,
  ): Promise<Risk> {
    const now = this.clock();
    const risk: Risk = {
      id: this.riskIdSource(),
      taskId,
      riskClass,
      statement,
      mitigation,
      status: mitigation ? "MITIGATED" : "IDENTIFIED",
      recordedAt: now,
    };

    const outboxMsg = this.outbox.createMessage(
      "risk",
      risk.id,
      1,
      "risk.recorded",
      {
        riskId: risk.id,
        taskId,
        riskClass,
        statement,
        mitigation,
      },
    );

    return this.repo.createRisk(risk, outboxMsg);
  }

  async mitigateRisk(riskId: string, mitigation: string): Promise<Risk> {
    const risk = await this.repo.getRisk(riskId);
    if (!risk) {
      throw new Error(`Risk ${riskId} not found`);
    }

    const updated: Risk = {
      ...risk,
      mitigation,
      status: "MITIGATED",
    };

    const outboxMsg = this.outbox.createMessage(
      "risk",
      updated.id,
      2,
      "risk.mitigated",
      {
        riskId: updated.id,
        taskId: updated.taskId,
        mitigation,
      },
    );

    return this.repo.updateRisk(updated, outboxMsg);
  }

  // ──────────────────────── Budgets ────────────────────────────────────────────

  async consumeBudget(
    taskId: string,
    delta: {
      costMicros?: bigint;
      computeSeconds?: number;
      inputTokens?: bigint;
      outputTokens?: bigint;
      approvals?: number;
    },
  ): Promise<BudgetConsumption> {
    const current = (await this.repo.getBudgetConsumption(taskId)) ?? {
      taskId,
      consumedCostMicros: 0n,
      consumedComputeSeconds: 0,
      consumedInputTokens: 0n,
      consumedOutputTokens: 0n,
      consumedApprovals: 0,
      lastUpdatedAt: this.clock(),
    };

    const updated: BudgetConsumption = {
      taskId,
      consumedCostMicros: current.consumedCostMicros + (delta.costMicros ?? 0n),
      consumedComputeSeconds: current.consumedComputeSeconds + (delta.computeSeconds ?? 0),
      consumedInputTokens: current.consumedInputTokens + (delta.inputTokens ?? 0n),
      consumedOutputTokens: current.consumedOutputTokens + (delta.outputTokens ?? 0n),
      consumedApprovals: current.consumedApprovals + (delta.approvals ?? 0),
      lastUpdatedAt: this.clock(),
    };

    const task = await this.repo.getTaskV2(taskId);
    if (task) {
      const budgetLimit = task.contract.constraints.costMicros;
      if (budgetLimit > 0n && updated.consumedCostMicros > budgetLimit) {
        const outboxExhausted = this.outbox.createMessage(
          "budget",
          taskId,
          1,
          "budget.exhausted",
          {
            taskId,
            limitKind: "costMicros",
            consumed: updated.consumedCostMicros.toString(),
            limit: budgetLimit.toString(),
          },
        );
        await this.repo.saveBudgetConsumption(updated, outboxExhausted);
        throw new BudgetExhaustedError(
          `Task ${taskId} exceeded cost budget: consumed ${updated.consumedCostMicros}µ > limit ${budgetLimit}µ`,
          "costMicros",
          updated.consumedCostMicros.toString(),
          budgetLimit.toString(),
        );
      }
    }

    const outboxMsg = this.outbox.createMessage(
      "budget",
      taskId,
      1,
      "budget.consumed",
      {
        taskId,
        consumedCostMicros: updated.consumedCostMicros,
        consumedComputeSeconds: updated.consumedComputeSeconds,
        consumedInputTokens: updated.consumedInputTokens,
        consumedOutputTokens: updated.consumedOutputTokens,
        consumedApprovals: updated.consumedApprovals,
      },
    );

    return this.repo.saveBudgetConsumption(updated, outboxMsg);
  }

  async checkBudget(
    taskId: string,
  ): Promise<{ ok: boolean; exceededKinds: string[] }> {
    const task = await this.repo.getTaskV2(taskId);
    if (!task) return { ok: true, exceededKinds: [] };

    const consumption = await this.repo.getBudgetConsumption(taskId);
    if (!consumption) return { ok: true, exceededKinds: [] };

    const exceeded: string[] = [];
    const limit = task.contract.constraints.costMicros;
    if (limit > 0n && consumption.consumedCostMicros > limit) {
      exceeded.push("costMicros");
    }

    return {
      ok: exceeded.length === 0,
      exceededKinds: exceeded,
    };
  }
}
