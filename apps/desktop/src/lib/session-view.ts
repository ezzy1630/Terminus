/**
 * Session-first task workspace (R12, harness critical path).
 *
 * The task-details surface previously defaulted to the governance views
 * (Mission Ledger / Effect Queue / Causal Replay / Fleet Budget) that encode
 * SPEC's org metaphors while no live-flow latency had ever been verified.
 * This module makes the live session the default and moves the governance
 * views behind an explicit opt-in flag, plus a first-token-latency tracker
 * so session responsiveness is measured instead of asserted.
 */

export const GOVERNANCE_VIEWS_KEY = "terminus-desktop.governance-views.enabled";

export type TaskWorkspaceTab =
  | "session"
  | "changes"
  | "overview"
  | "activity"
  | "replay"
  | "usage"
  | "evidence";

export interface TabDefinition<TValue extends string = string> {
  readonly value: TValue;
  readonly label: string;
}

/** Governance views are off unless explicitly enabled in this browser. */
export function readGovernanceViewsEnabled(storage: Storage | null): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(GOVERNANCE_VIEWS_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeGovernanceViewsEnabled(storage: Storage | null, enabled: boolean): void {
  if (storage === null) return;
  try {
    storage.setItem(GOVERNANCE_VIEWS_KEY, enabled ? "true" : "false");
  } catch {
    // Preference persistence is optional; the in-memory value still applies.
  }
}

const SESSION_TABS: readonly TabDefinition<TaskWorkspaceTab>[] = [
  { value: "session", label: "Session" },
  { value: "changes", label: "Changes" },
];

const GOVERNANCE_TABS: readonly TabDefinition<TaskWorkspaceTab>[] = [
  { value: "overview", label: "Overview" },
  { value: "activity", label: "Activity" },
  { value: "replay", label: "Replay" },
  { value: "usage", label: "Usage" },
  { value: "evidence", label: "Evidence" },
];

/** Session-first tab order; governance tabs append only when enabled. */
export function taskWorkspaceTabs(governanceEnabled: boolean): readonly TabDefinition<TaskWorkspaceTab>[] {
  return governanceEnabled ? [...SESSION_TABS, ...GOVERNANCE_TABS] : SESSION_TABS;
}

export function parseTaskWorkspaceTab(value: string): TaskWorkspaceTab | null {
  switch (value) {
    case "session":
    case "changes":
    case "overview":
    case "activity":
    case "replay":
    case "usage":
    case "evidence":
      return value;
    default:
      return null;
  }
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

/** Custom event dispatched when the governance preference flips in-session. */
export const GOVERNANCE_VIEWS_CHANGED_EVENT = "terminus:governance-views-changed";

export function applyGovernanceViewsEnabled(storage: Storage | null, enabled: boolean): void {
  writeGovernanceViewsEnabled(storage, enabled);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(GOVERNANCE_VIEWS_CHANGED_EVENT, { detail: enabled }));
  }
}
