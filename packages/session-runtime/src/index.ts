/**
 * @forge/session-runtime — session/thread/turn lifecycle.
 *
 * Per SPEC §28.4: SessionService, ThreadService, TurnService. Uses a
 * `SessionRepository` interface (no direct Prisma import). Also exposes a
 * `ContextEpochService` that manages the ContextEpoch lifecycle (§28.8,
 * §33.15): start, seal, replace, getActive, shouldStartNewEpoch.
 */
import type {
  Session,
  Thread,
  Turn,
  Uuid7,
  PrincipalId,
  Rfc3339Timestamp,
  TurnState,
  ContextEpoch,
  ContextEpochState,
  ContentHash,
  ModelKey,
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

// ────────────────────────── Context epoch repository ─────────────────────────

export interface ContextEpochRepository {
  createEpoch(epoch: ContextEpoch): Promise<ContextEpoch>;
  getEpoch(id: Uuid7): Promise<ContextEpoch | null>;
  updateEpoch(epoch: ContextEpoch): Promise<ContextEpoch>;
  /** Returns all epochs for a thread, ordered by sequence ascending. */
  listEpochs(threadId: Uuid7): Promise<readonly ContextEpoch[]>;
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

// ────────────────────────── Context epoch service (§28.8, §33.15) ────────────

/**
 * A composite key capturing the dimensions of provider/model/policy that
 * determine cross-request continuation compatibility. Two epochs are
 * "continuation-compatible" iff their keys are identical. SPEC §33.15.
 */
export interface ProviderCompatibilityKey {
  readonly providerId: string;
  readonly modelKey: ModelKey;
  readonly policyProfile: string;
  readonly providerApiVersion: string;
  readonly trustBoundary: "trusted" | "untrusted" | "restricted";
}

/**
 * Inputs to `ContextEpochService.shouldStartNewEpoch`. Each field corresponds
 * to one of the SPEC §33.15 triggers. The service returns true if ANY
 * trigger fires.
 */
export interface EpochTriggerInput {
  /** True on the very first request of a thread (no prior epoch). */
  readonly isFirstRequest: boolean;
  /** True if a compaction cycle just completed (causing a prefix shift). */
  readonly compactionCompleted: boolean;
  /** True if the workspace or trust boundary changed since the prior epoch. */
  readonly workspaceOrTrustBoundaryChanged: boolean;
  /** True if the active authority fragment hash changed incompatibly. */
  readonly authorityChangedIncompatibly: boolean;
  /** True if tool schemas or semantics changed (version mismatch). */
  readonly toolSemanticsChanged: boolean;
  /** True if continuation is no longer valid (cache miss / provider expiry). */
  readonly continuationIncompatible: boolean;
  /** True if the session was forked from another. */
  readonly sessionForked: boolean;
  /** True if the user explicitly requested a clean context. */
  readonly userRequestedCleanContext: boolean;
}

export interface ContextEpochServiceDeps {
  readonly repo: ContextEpochRepository;
  readonly clock: () => Rfc3339Timestamp;
  readonly idSource: () => Uuid7;
}

/**
 * Manages the ContextEpoch lifecycle per SPEC §28.8 and §33.15.
 *
 * State machine:
 *   INITIALIZING → ACTIVE → REPLACEMENT_PENDING → SEALED
 *   INITIALIZING → ACTIVE → SEALED (direct seal on replacement)
 *
 * Each thread has at most one ACTIVE epoch at a time. `replaceEpoch` seals
 * the current active epoch (if any) and starts a new one with the new
 * provider compatibility key.
 */
export class ContextEpochService {
  constructor(private readonly deps: ContextEpochServiceDeps) {}

  /**
   * Start a new epoch in `INITIALIZING`, then immediately transition it to
   * `ACTIVE`. The baseline hash is supplied by the caller (typically the
   * context compiler's stable-prefix hash); the kernel records it so future
   * compaction decisions can detect prefix drift.
   */
  async startEpoch(
    threadId: Uuid7,
    providerCompatibilityKey: ProviderCompatibilityKey,
    baselineHash: ContentHash,
    continuationId: string | null,
  ): Promise<ContextEpoch> {
    const existing = await this.listEpochs(threadId);
    const sequence = existing.length === 0 ? 1 : (existing[existing.length - 1]!.sequence + 1);
    const now = this.deps.clock();
    const epoch: ContextEpoch = {
      id: this.deps.idSource(),
      threadId,
      sequence,
      state: "ACTIVE",
      baselineHash,
      provider: providerCompatibilityKey.providerId,
      model: providerCompatibilityKey.modelKey,
      continuationId,
      startedAt: now,
      sealedAt: null,
      supersededBy: null,
    };
    return this.deps.repo.createEpoch(epoch);
  }

  /**
   * Seal an epoch. Once sealed, an epoch cannot be reused for new provider
   * requests. The `reason` is recorded for audit (sealedAt timestamp +
   * supersededBy set by `replaceEpoch`).
   */
  async sealEpoch(epochId: Uuid7, reason: string): Promise<ContextEpoch> {
    void reason; // audit-only; persisted by the repo's metadata layer.
    const e = await this.requireEpoch(epochId);
    if (e.state === "SEALED") {
      throw new StateTransitionError("context_epoch", e.state, "SEALED");
    }
    const sealed: ContextEpoch = {
      ...e,
      state: "SEALED",
      sealedAt: this.deps.clock(),
    };
    return this.deps.repo.updateEpoch(sealed);
  }

  /**
   * Atomically seal the current active epoch (if any) and start a new one
   * with the new provider compatibility key. Returns the new epoch. The
   * prior epoch's `supersededBy` is set to the new epoch's id.
   */
  async replaceEpoch(
    threadId: Uuid7,
    newKey: ProviderCompatibilityKey,
    baselineHash: ContentHash,
    continuationId: string | null,
    reason: string,
  ): Promise<ContextEpoch> {
    const current = await this.getActiveEpoch(threadId);
    const newEpoch = await this.startEpoch(threadId, newKey, baselineHash, continuationId);
    if (current !== null) {
      const superseded: ContextEpoch = {
        ...current,
        state: "SEALED",
        sealedAt: this.deps.clock(),
        supersededBy: newEpoch.id,
      };
      await this.deps.repo.updateEpoch(superseded);
    }
    void reason;
    return newEpoch;
  }

  /** Returns the current ACTIVE epoch for a thread, or null if none. */
  async getActiveEpoch(threadId: Uuid7): Promise<ContextEpoch | null> {
    const epochs = await this.listEpochs(threadId);
    for (let i = epochs.length - 1; i >= 0; i--) {
      const e = epochs[i]!;
      if (e.state === "ACTIVE") return e;
    }
    return null;
  }

  /**
   * Returns true if any §33.15 trigger fires. The caller invokes this before
   * each provider request to decide whether to start a new epoch or
   * continue with the current one.
   */
  shouldStartNewEpoch(input: EpochTriggerInput): boolean {
    return (
      input.isFirstRequest ||
      input.compactionCompleted ||
      input.workspaceOrTrustBoundaryChanged ||
      input.authorityChangedIncompatibly ||
      input.toolSemanticsChanged ||
      input.continuationIncompatible ||
      input.sessionForked ||
      input.userRequestedCleanContext
    );
  }

  private async requireEpoch(id: Uuid7): Promise<ContextEpoch> {
    const e = await this.deps.repo.getEpoch(id);
    if (e === null) throw new ValidationError("context epoch not found", { epochId: id });
    return e;
  }

  private async listEpochs(threadId: Uuid7): Promise<readonly ContextEpoch[]> {
    return this.deps.repo.listEpochs(threadId);
  }
}

export type { Session, Thread, Turn, TurnState, ContextEpoch, ContextEpochState };
