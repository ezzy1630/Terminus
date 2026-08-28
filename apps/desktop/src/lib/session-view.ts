/**
 * Session-first task workspace.
 *
 * The workspace used to carry five extra "governance" tabs (Mission Ledger /
 * Effect Queue / Causal Replay / Fleet Budget / Claim Evidence) behind a
 * localStorage flag, encoding SPEC's organisation metaphors in surfaces no
 * user reached. The flag and those views are gone. The data they read is not
 * lost: effects, budget, claims and evidence are the inputs to the approvals
 * surface, the usage meter and verification cards, and are surfaced there
 * instead of in a parallel tab strip.
 */

export type TaskWorkspaceTab = "session" | "changes";

export interface TabDefinition<TValue extends string = string> {
  readonly value: TValue;
  readonly label: string;
}

const SESSION_TABS: readonly TabDefinition<TaskWorkspaceTab>[] = [
  { value: "session", label: "Session" },
  { value: "changes", label: "Changes" },
];

export function taskWorkspaceTabs(): readonly TabDefinition<TaskWorkspaceTab>[] {
  return SESSION_TABS;
}

export function parseTaskWorkspaceTab(value: string): TaskWorkspaceTab | null {
  return value === "session" || value === "changes" ? value : null;
}

// ────────────────────────── TTFT instrumentation ────────────────────────────

export interface TurnLatencySample {
  readonly taskId: string;
  readonly submittedAtMs: number;
  readonly firstEventAtMs: number | null;
  readonly ttftMs: number | null;
}

interface PendingTurn {
  readonly submittedAtMs: number;
}

/**
 * Ring-buffered time-to-first-streamed-event tracker. Submit is marked when
 * the Composer's startTurn mutation settles; the first subsequent stream
 * event for that task closes the sample. Pure and injectable-clock so tests
 * are deterministic.
 */
export class SessionLatencyTracker {
  private readonly pending = new Map<string, PendingTurn>();
  private readonly samples: TurnLatencySample[] = [];

  constructor(
    private readonly maxSamples = 50,
    private readonly now: () => number = () => Date.now(),
  ) {}

  markTurnSubmitted(taskId: string): void {
    this.pending.set(taskId, { submittedAtMs: this.now() });
  }

  /** Record one stream event; returns a closed sample on TTFT completion. */
  observeStreamEvent(taskId: string, _eventType: string): TurnLatencySample | null {
    const pending = this.pending.get(taskId);
    if (pending === undefined) return null;
    const firstEventAtMs = this.now();
    const ttftMs = Math.max(0, firstEventAtMs - pending.submittedAtMs);
    this.pending.delete(taskId);
    const sample: TurnLatencySample = { taskId, submittedAtMs: pending.submittedAtMs, firstEventAtMs, ttftMs };
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    return sample;
  }

  cancelPending(taskId: string): void {
    this.pending.delete(taskId);
  }

  get samplesSnapshot(): readonly TurnLatencySample[] {
    return [...this.samples];
  }

  p50TtftMs(): number | null {
    return this.percentileTtft(0.5);
  }

  p95TtftMs(): number | null {
    return this.percentileTtft(0.95);
  }

  private percentileTtft(q: number): number | null {
    const values = this.samples
      .map((sample) => sample.ttftMs)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    if (values.length === 0) return null;
    const index = Math.min(values.length - 1, Math.max(0, Math.ceil(q * values.length) - 1));
    return values[index]!;
  }
}
