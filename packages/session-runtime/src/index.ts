/**
 * @forge/session-runtime — session/thread/turn lifecycle.
 *
 * Per SPEC §28.4: SessionService, ThreadService, TurnService. Uses a
 * `SessionRepository` interface (no direct Prisma import).
 */
import type {
  Session,
  Thread,
  Turn,
  Uuid7,
  PrincipalId,
  Rfc3339Timestamp,
  TurnState,
} from "@forge/domain";
import {
  StateTransitionError,
  ValidationError,
  isTurnTransitionAllowed,
  TURN_TRANSITIONS,
} from "@forge/domain";
import type { EventSink } from "@forge/runtime-protocol";

// ────────────────────────── Repository ───────────────────────────────────────

export interface SessionRepository {
  createSession(s: Session): Promise<Session>;
  getSession(id: Uuid7): Promise<Session | null>;
  updateSession(s: Session): Promise<Session>;
  createThread(t: Thread): Promise<Thread>;
  getThread(id: Uuid7): Promise<Thread | null>;
  updateThread(t: Thread): Promise<Thread>;
  listThreads(sessionId: Uuid7): Promise<readonly Thread[]>;
  createTurn(t: Turn): Promise<Turn>;
  getTurn(id: Uuid7): Promise<Turn | null>;
  updateTurn(t: Turn): Promise<Turn>;
  listTurns(threadId: Uuid7): Promise<readonly Turn[]>;
}

// ────────────────────────── Services ─────────────────────────────────────────

export interface SessionServiceDeps {
  readonly repo: SessionRepository;
  readonly events: EventSink;
  readonly clock: () => Rfc3339Timestamp;
  readonly idSource: () => Uuid7;
}

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  async openWorkspace(input: {
    readonly workspaceId: Uuid7;
    readonly owner: PrincipalId;
    readonly title: string;
  }): Promise<Session> {
    const now = this.deps.clock();
    const session: Session = {
      id: this.deps.idSource(),
      workspaceId: input.workspaceId,
      ownerPrincipal: input.owner,
      title: input.title,
      status: "active",
      createdAt: now,
      updatedAt: now,
      defaultModelProfile: null,
      defaultPermissionProfile: null,
      activeThreadId: null,
      metadata: {},
    };
    return this.deps.repo.createSession(session);
  }

  async createSession(input: {
    readonly workspaceId: Uuid7;
    readonly owner: PrincipalId;
    readonly title: string;
  }): Promise<Session> {
    return this.openWorkspace(input);
  }

  async pause(sessionId: Uuid7): Promise<Session> {
    const s = await this.requireSession(sessionId);
    if (s.status !== "active") {
      throw new StateTransitionError("session", s.status, "paused");
    }
    return this.deps.repo.updateSession({ ...s, status: "paused", updatedAt: this.deps.clock() });
  }

  async archive(sessionId: Uuid7): Promise<Session> {
    const s = await this.requireSession(sessionId);
    return this.deps.repo.updateSession({ ...s, status: "archived", updatedAt: this.deps.clock() });
  }

  private async requireSession(id: Uuid7): Promise<Session> {
    const s = await this.deps.repo.getSession(id);
    if (s === null) throw new ValidationError("session not found", { sessionId: id });
    return s;
  }
}

export class ThreadService {
  constructor(private readonly deps: SessionServiceDeps) {}

  async create(input: {
    readonly sessionId: Uuid7;
    readonly parentThreadId?: Uuid7 | undefined;
    readonly forkedFromTurnId?: Uuid7 | undefined;
  }): Promise<Thread> {
    const now = this.deps.clock();
    const thread: Thread = {
      id: this.deps.idSource(),
      sessionId: input.sessionId,
      parentThreadId: input.parentThreadId ?? null,
      forkedFromTurnId: input.forkedFromTurnId ?? null,
      status: "active",
      activeContextEpochId: null,
      headTurnId: null,
      createdAt: now,
    };
    return this.deps.repo.createThread(thread);
  }

  async fork(threadId: Uuid7, fromTurnId: Uuid7): Promise<Thread> {
    const parent = await this.requireThread(threadId);
    return this.create({
      sessionId: parent.sessionId,
      parentThreadId: threadId,
      forkedFromTurnId: fromTurnId,
    });
  }

  async listTurns(threadId: Uuid7): Promise<readonly Turn[]> {
    return this.deps.repo.listTurns(threadId);
  }

  private async requireThread(id: Uuid7): Promise<Thread> {
    const t = await this.deps.repo.getThread(id);
    if (t === null) throw new ValidationError("thread not found", { threadId: id });
    return t;
  }
}

export class TurnService {
  constructor(private readonly deps: SessionServiceDeps) {}

  async start(input: {
    readonly threadId: Uuid7;
    readonly taskId?: Uuid7 | undefined;
    readonly initiatedBy: PrincipalId;
  }): Promise<Turn> {
    const now = this.deps.clock();
    const thread = await this.deps.repo.getThread(input.threadId);
    if (thread === null) {
      throw new ValidationError("thread not found", { threadId: input.threadId });
    }
    const prior = await this.deps.repo.listTurns(input.threadId);
    const sequence = prior.length + 1;
    const turn: Turn = {
      id: this.deps.idSource(),
      threadId: input.threadId,
      taskId: input.taskId ?? null,
      sequence,
      state: "PENDING",
      initiatedBy: input.initiatedBy,
      startedAt: now,
      finalizedAt: null,
    };
    const saved = await this.deps.repo.createTurn(turn);
    await this.deps.events.emit(
      "turn.started",
      {
        turnId: saved.id,
        threadId: saved.threadId,
        taskId: saved.taskId,
        initiatedBy: saved.initiatedBy,
      },
      {
        aggregateId: saved.id,
        aggregateSequence: sequence,
        actor: { kind: "user", id: input.initiatedBy },
        occurredAt: now,
      },
    );
    return saved;
  }

  async transition(turnId: Uuid7, to: TurnState): Promise<Turn> {
    const turn = await this.requireTurn(turnId);
    if (turn.state === to) return turn;
    if (!isTurnTransitionAllowed(turn.state, to)) {
      throw new StateTransitionError("turn", turn.state, to);
    }
    const updated: Turn = {
      ...turn,
      state: to,
      finalizedAt:
        to === "COMPLETED" || to === "FAILED" || to === "INTERRUPTED" ? this.deps.clock() : turn.finalizedAt,
    };
    return this.deps.repo.updateTurn(updated);
  }

  async interrupt(turnId: Uuid7): Promise<Turn> {
    return this.transition(turnId, "INTERRUPTED");
  }

  async resume(turnId: Uuid7): Promise<Turn> {
    const turn = await this.requireTurn(turnId);
    if (turn.state !== "INTERRUPTED") {
      throw new StateTransitionError("turn", turn.state, "PENDING");
    }
    return this.transition(turnId, "PENDING");
  }

  private async requireTurn(id: Uuid7): Promise<Turn> {
    const t = await this.deps.repo.getTurn(id);
    if (t === null) throw new ValidationError("turn not found", { turnId: id });
    return t;
  }
}

export const TURN_STATE_TRANSITIONS = TURN_TRANSITIONS;
export { isTurnTransitionAllowed };

export type { Session, Thread, Turn, TurnState };
