import type { MutationRunner, ServiceEventAppender } from "./service-types.js";

export type TurnAdmissionReason =
  | "task_not_found"
  | "thread_mismatch"
  | "state_conflict"
  | "turn_active"
  | "state_changed"
  | "sequence_changed";

export class TurnAdmissionError extends Error {
  constructor(
    readonly reason: TurnAdmissionReason,
    readonly detail: string | null = null,
  ) {
    super(reason);
    this.name = "TurnAdmissionError";
  }
}

export interface TurnTaskSnapshot {
  readonly id: string;
  readonly threadId: string;
  readonly status: string;
}

export interface TurnRow {
  readonly id: string;
  readonly threadId: string;
  readonly taskId: string | null;
  readonly sequence: number;
  readonly state: string;
  readonly initiatingActor: string;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface TurnAdmissionInput {
  readonly turnId: string;
  readonly threadId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly inputArtifactUri: string;
  readonly inputArtifactHash: string;
  readonly initiatingActor: string;
}

export interface TurnCoordinatorTransaction {
  readonly findTask: (taskId: string) => Promise<TurnTaskSnapshot | null>;
  readonly findActiveTurn: (taskId: string, activeStates: readonly string[]) => Promise<{ readonly id: string } | null>;
  readonly findLatestSequence: (threadId: string) => Promise<number | null>;
  readonly resumeTask: (taskId: string, expectedStatus: string) => Promise<void>;
  readonly createTurn: (input: TurnAdmissionInput) => Promise<void>;
  readonly createUserEpisode: (input: TurnAdmissionInput) => Promise<void>;
  readonly interruptTurn: (turnId: string, reason: string) => Promise<void>;
  /** Mark a turn cancelled after durable cancellation intent is recorded. */
  readonly abortTurn?: (turnId: string, reason: string) => Promise<void>;
}

export interface TurnCoordinatorDependencies<TTransaction> {
  readonly readTask: (taskId: string) => Promise<TurnTaskSnapshot | null>;
  readonly readTurn: (turnId: string) => Promise<TurnRow | null>;
  readonly appendEvent: ServiceEventAppender<TTransaction>;
  readonly transaction: (transaction: TTransaction) => TurnCoordinatorTransaction;
  readonly mutate: MutationRunner;
  readonly projectTask: (taskId: string, eventType: string) => Promise<void>;
  readonly activeTurnStates: readonly string[];
}

export interface AdmittedTurn {
  readonly turn: TurnRow;
}

/**
 * Owns turn admission and interruption without owning the HTTP route.
 *
 * Transaction boundary: admission uses one event-plus-row transaction. The
 * preflight read is only an early error response; the transaction repeats all
 * lineage, state, active-turn, and sequence checks before creating the turn.
 */
export class TurnCoordinator<TTransaction> {
  constructor(
    private readonly dependencies: TurnCoordinatorDependencies<TTransaction>,
  ) {}

  async admit(input: TurnAdmissionInput): Promise<AdmittedTurn> {
    return this.dependencies.mutate(() => this.admitUnderMutationLock(input));
  }

  /**
   * Admit a turn when the composition root already holds its mutation lock.
   * This keeps route-level idempotency serialization and the coordinator's
   * transaction boundary separate without attempting to reacquire a
   * non-reentrant mutex.
   */
  async admitUnderMutationLock(input: TurnAdmissionInput): Promise<AdmittedTurn> {
    const task = await this.dependencies.readTask(input.taskId);
    if (task === null) throw new TurnAdmissionError("task_not_found");
    if (task.threadId !== input.threadId) {
      throw new TurnAdmissionError("thread_mismatch", task.threadId);
    }
    if (!["ACTIVE", "NEEDS_USER_DECISION", "BLOCKED"].includes(task.status)) {
      throw new TurnAdmissionError("state_conflict", task.status);
    }

    await this.dependencies.appendEvent(
      {
        eventType: "turn.started",
        aggregateType: "turn",
        aggregateId: input.turnId,
        correlationId: input.taskId,
        payload: {
          thread_id: input.threadId,
          task_id: input.taskId,
          sequence: input.sequence,
          input_artifact: input.inputArtifactUri,
          input_hash: input.inputArtifactHash,
        },
        artifactRefs: [input.inputArtifactUri],
      },
      async (transaction) => {
        const store = this.dependencies.transaction(transaction);
        const current = await store.findTask(input.taskId);
        if (current === null) throw new TurnAdmissionError("task_not_found");
        if (current.threadId !== input.threadId) {
          throw new TurnAdmissionError("thread_mismatch", current.threadId);
        }
        if (!["ACTIVE", "NEEDS_USER_DECISION", "BLOCKED"].includes(current.status)) {
          throw new TurnAdmissionError("state_conflict", current.status);
        }
        // A pending repair blocks ordinary user admission. The repair
        // controller is the sole actor allowed to add the continuation turn
        // while its parent remains in REPAIR_PENDING.
        const activeStates = input.initiatingActor === "repair-controller"
          ? this.dependencies.activeTurnStates
          : [...this.dependencies.activeTurnStates, "REPAIR_PENDING"];
        const activeTurn = await store.findActiveTurn(input.taskId, activeStates);
        if (activeTurn !== null) throw new TurnAdmissionError("turn_active", activeTurn.id);
        const previousSequence = await store.findLatestSequence(input.threadId);
        if ((previousSequence ?? 0) + 1 !== input.sequence) {
          throw new TurnAdmissionError("sequence_changed");
        }
        if (current.status !== "ACTIVE") {
          await store.resumeTask(input.taskId, current.status);
        }
        await store.createTurn(input);
        await store.createUserEpisode(input);
      },
    );

    const turn = await this.dependencies.readTurn(input.turnId);
    if (turn === null) throw new Error(`admitted turn ${input.turnId} could not be reloaded`);
    await this.dependencies.projectTask(input.taskId, "task.running");
    return { turn };
  }

  async interrupt(turnId: string, reason: string): Promise<TurnRow> {
    return this.dependencies.mutate(() => this.interruptUnderMutationLock(turnId, reason));
  }

  /** Caller already holds the composition root's mutation lock. */
  async interruptUnderMutationLock(turnId: string, reason: string): Promise<TurnRow> {
    const current = await this.dependencies.readTurn(turnId);
    if (current === null) throw new TurnAdmissionError("task_not_found", turnId);
    if (!this.dependencies.activeTurnStates.includes(current.state)) {
      throw new TurnAdmissionError("state_conflict", current.state);
    }

    await this.dependencies.appendEvent(
      {
        eventType: "turn.interrupted",
        aggregateType: "turn",
        aggregateId: turnId,
        correlationId: current.taskId ?? turnId,
        payload: { reason },
      },
      async (transaction) => {
        await this.dependencies.transaction(transaction).interruptTurn(turnId, reason);
      },
    );
    const interrupted = await this.dependencies.readTurn(turnId);
    if (interrupted === null) throw new Error(`interrupted turn ${turnId} could not be reloaded`);
    return interrupted;
  }

  /**
   * Persist cancellation at the turn boundary before asking the in-process
   * executor to stop. REPAIR_PENDING is included because it is nonterminal
   * but intentionally excluded from the normal admission active-state set.
   */
  async abortUnderMutationLock(turnId: string, reason: string): Promise<TurnRow> {
    const current = await this.dependencies.readTurn(turnId);
    if (current === null) throw new TurnAdmissionError("task_not_found", turnId);
    if (
      !this.dependencies.activeTurnStates.includes(current.state)
      && current.state !== "REPAIR_PENDING"
    ) {
      throw new TurnAdmissionError("state_conflict", current.state);
    }

    await this.dependencies.appendEvent(
      {
        eventType: "turn.aborted",
        aggregateType: "turn",
        aggregateId: turnId,
        correlationId: current.taskId ?? turnId,
        payload: {
          reason,
          previous_state: current.state,
          phase: current.state,
        },
      },
      async (transaction) => {
        const store = this.dependencies.transaction(transaction);
        if (store.abortTurn !== undefined) {
          await store.abortTurn(turnId, reason);
        } else {
          // Compatibility for older test/adaptor stores. Production wiring
          // supplies abortTurn and therefore records the ABORTED state.
          await store.interruptTurn(turnId, reason);
        }
      },
    );
    const aborted = await this.dependencies.readTurn(turnId);
    if (aborted === null) throw new Error(`aborted turn ${turnId} could not be reloaded`);
    return aborted;
  }
}
