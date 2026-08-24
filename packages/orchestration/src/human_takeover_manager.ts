/** Human takeover coordinator. Input transfer is delegated to an explicit backend. */
import {
  ConflictError,
  NotFoundError,
  SandboxUnavailableError,
  ValidationError,
  generateUuid7,
  humanTakeoverSessionSchema,
  nowTimestamp,
  uiObservationSchema,
  type HumanTakeoverSession,
  type UiObservation,
} from "@terminus/domain";

export interface TakeoverControlBackend {
  readonly transferToHuman: (input: {
    readonly taskId: string;
    readonly poolId: string;
    readonly surface: "browser" | "desktop";
  }) => Promise<{ readonly confirmed: boolean }>;
  readonly transferToAgent: (input: {
    readonly taskId: string;
    readonly poolId: string;
    readonly surface: "browser" | "desktop";
    readonly observationId: string;
  }) => Promise<{ readonly confirmed: boolean }>;
}

export class HumanTakeoverManager {
  private readonly sessions = new Map<string, HumanTakeoverSession>();
  private readonly auditLog = new Map<string, readonly string[]>();

  public constructor(private readonly backend: TakeoverControlBackend | null = null) {}

  public async initiateTakeover(
    poolId: string,
    surface: "browser" | "desktop",
    reason: string,
    rawObservation: UiObservation,
  ): Promise<HumanTakeoverSession> {
    uiObservationSchema.parse(rawObservation);
    const observation = rawObservation;
    if (reason.trim().length === 0) throw new ValidationError("Human takeover requires a reason");
    if (this.getActiveTakeoverForTask(observation.taskId) !== null) {
      throw new ConflictError(
        "ALREADY_EXISTS",
        `Task ${observation.taskId} already has an active human takeover`,
        { taskId: observation.taskId },
      );
    }
    if (this.backend === null) {
      throw new SandboxUnavailableError(
        "Human takeover is coordinator-only because no input-control backend is configured",
        { taskId: observation.taskId, poolId, surface },
      );
    }
    const transfer = await this.backend.transferToHuman({
      taskId: observation.taskId,
      poolId,
      surface,
    });
    if (!transfer.confirmed) {
      throw new SandboxUnavailableError("Input-control backend did not confirm human takeover", {
        taskId: observation.taskId,
        poolId,
        surface,
      });
    }

    const startedAt = nowTimestamp();
    const session: HumanTakeoverSession = {
      takeoverId: generateUuid7(),
      taskId: observation.taskId,
      poolId,
      surface,
      state: "human_control",
      startedAt,
      resumedAt: null,
      preTakeoverObservationId: observation.id,
      preTakeoverObservationVersion: observation.version,
      resumeObservationId: null,
      reason,
    };
    humanTakeoverSessionSchema.parse(session);
    this.sessions.set(session.takeoverId, session);
    this.auditLog.set(session.takeoverId, [
      `[${startedAt}] Input-control backend confirmed transfer to the human operator`,
    ]);
    return { ...session };
  }

  public recordAction(takeoverId: string, description: string): void {
    const session = this.requireSession(takeoverId);
    if (session.state !== "human_control") {
      throw new ConflictError(
        "STATE_TRANSITION_INVALID",
        `Cannot record a human action while takeover is ${session.state}`,
        { takeoverId, state: session.state },
      );
    }
    if (description.trim().length === 0) throw new ValidationError("Takeover action description is required");
    const log = this.auditLog.get(takeoverId) ?? [];
    this.auditLog.set(takeoverId, [
      ...log,
      `[${nowTimestamp()}] Human action observed: ${description}`,
    ]);
  }

  public async resumeAutonomous(
    takeoverId: string,
    rawObservation: UiObservation,
  ): Promise<HumanTakeoverSession> {
    const session = this.requireSession(takeoverId);
    if (session.state !== "human_control") {
      throw new ConflictError(
        "STATE_TRANSITION_INVALID",
        `Cannot resume autonomous control from ${session.state}`,
        { takeoverId, state: session.state },
      );
    }
    uiObservationSchema.parse(rawObservation);
    const observation = rawObservation;
    if (observation.taskId !== session.taskId) {
      throw new ValidationError("Resume observation belongs to a different task", {
        takeoverTaskId: session.taskId,
        observationTaskId: observation.taskId,
      });
    }
    if (
      observation.id === session.preTakeoverObservationId
      || observation.version <= session.preTakeoverObservationVersion
      || Date.parse(observation.timestamp) < Date.parse(session.startedAt)
    ) {
      throw new ValidationError("Resume requires a fresh post-takeover observation", {
        observationId: observation.id,
        observationVersion: observation.version,
        baselineObservationId: session.preTakeoverObservationId,
        baselineObservationVersion: session.preTakeoverObservationVersion,
      });
    }
    if (this.backend === null) {
      throw new SandboxUnavailableError("Cannot return control to the agent without an input-control backend", {
        takeoverId,
      });
    }

    const pending: HumanTakeoverSession = {
      ...session,
      state: "resume_pending_observation",
      resumeObservationId: observation.id,
    };
    humanTakeoverSessionSchema.parse(pending);
    this.sessions.set(takeoverId, pending);
    const transfer = await this.backend.transferToAgent({
      taskId: session.taskId,
      poolId: session.poolId,
      surface: session.surface,
      observationId: observation.id,
    });
    if (!transfer.confirmed) {
      this.sessions.set(takeoverId, session);
      throw new SandboxUnavailableError("Input-control backend did not confirm return to the agent", {
        takeoverId,
        observationId: observation.id,
      });
    }

    const resumedAt = nowTimestamp();
    const resumed: HumanTakeoverSession = {
      ...pending,
      state: "agent_control",
      resumedAt,
    };
    humanTakeoverSessionSchema.parse(resumed);
    this.sessions.set(takeoverId, resumed);
    const log = this.auditLog.get(takeoverId) ?? [];
    this.auditLog.set(takeoverId, [
      ...log,
      `[${resumedAt}] Input-control backend confirmed agent resume from observation ${observation.id}`,
    ]);
    return { ...resumed };
  }

  public getSession(takeoverId: string): HumanTakeoverSession | null {
    const session = this.sessions.get(takeoverId);
    return session === undefined ? null : { ...session };
  }

  public getActiveTakeoverForTask(taskId: string): HumanTakeoverSession | null {
    for (const session of this.sessions.values()) {
      if (session.taskId === taskId && session.state !== "agent_control") return { ...session };
    }
    return null;
  }

  public getAuditLog(takeoverId: string): readonly string[] {
    return [...(this.auditLog.get(takeoverId) ?? [])];
  }

  private requireSession(takeoverId: string): HumanTakeoverSession {
    const session = this.sessions.get(takeoverId);
    if (session === undefined) throw new NotFoundError("human takeover", takeoverId);
    return session;
  }
}
