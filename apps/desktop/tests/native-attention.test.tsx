/**
 * The Dock badge and native notifications.
 *
 * Terminus runs agents that work for minutes at a time, so the app is usually
 * in the background when it has something to say. Until now it said nothing:
 * `notify` existed in the preload bridge and no renderer code ever called it,
 * and `app.setBadgeCount` was never called at all — so a task waiting on an
 * approval was invisible unless the window happened to be on screen.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useNativeAttention } from "../src/hooks/use-native-attention";
import { useTerminusStore } from "../src/hooks/use-terminus";
import * as apiV2Module from "../src/lib/api-v2";
import type { ArpV2EventStream } from "../src/lib/api-v2";
import type { Task, TaskDomainStatus } from "../src/types";
import type { ArpV2EventEnvelope } from "../src/types/v2";

function task(id: string, status: TaskDomainStatus, overrides: Partial<Task> = {}): Task {
  return {
    id,
    session_id: "session-1",
    thread_id: "thread-1",
    status,
    phase: "EXECUTE",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: "2026-08-28T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
    completed_at: null,
    terminal_reason: null,
    contract: null,
    ...overrides,
  };
}

function install(tasks: Task[]): void {
  useTerminusStore.setState({ tasksBySession: { "session-1": tasks } });
}

interface Bridge {
  notify: ReturnType<typeof vi.fn>;
  setAttentionCount: ReturnType<typeof vi.fn>;
  onOpenTask: ReturnType<typeof vi.fn>;
  deliverOpenTask?: (taskId: string) => void;
}

function installBridge(): Bridge {
  const bridge: Bridge = {
    notify: vi.fn(async () => undefined),
    setAttentionCount: vi.fn(async () => undefined),
    onOpenTask: vi.fn((callback: (taskId: string) => void) => {
      bridge.deliverOpenTask = callback;
      return () => { bridge.deliverOpenTask = undefined; };
    }),
  };
  (window as { terminusDesktop?: unknown }).terminusDesktop = bridge;
  return bridge;
}

function Probe({ onOpenTask }: { onOpenTask?: (taskId: string) => void }): JSX.Element {
  useNativeAttention(onOpenTask ?? (() => undefined));
  return <div />;
}

function inertStream(): ArpV2EventStream {
  return {
    readyState: 1,
    lastEventId: null,
    addEventListener: () => () => {},
    close: vi.fn(),
  };
}

beforeEach(() => {
  cleanup();
  install([]);
  vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue(inertStream());
  // The app is in the background: that is when these signals are for.
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as { terminusDesktop?: unknown }).terminusDesktop;
});

describe("Dock badge", () => {
  test("refreshes the workspace after a task event when no transcript is open", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, Set<(event?: ArpV2EventEnvelope) => void>>();
    const stream: ArpV2EventStream = {
      readyState: 1,
      lastEventId: null,
      addEventListener(type, handler) {
        const listeners = handlers.get(type) ?? new Set();
        listeners.add(handler as (event?: ArpV2EventEnvelope) => void);
        handlers.set(type, listeners);
        return () => listeners.delete(handler as (event?: ArpV2EventEnvelope) => void);
      },
      close: vi.fn(),
    };
    vi.mocked(apiV2Module.subscribeEventsV2).mockReturnValue(stream);
    const refreshAll = vi.spyOn(useTerminusStore.getState(), "refreshAll").mockResolvedValue();

    const view = render(<Probe />);
    const event: ArpV2EventEnvelope = {
      eventId: "event-1",
      eventType: "task.running",
      schemaVersion: 2,
      aggregateType: "task",
      aggregateId: "task-1",
      aggregateSequence: 1,
      occurredAt: "2026-08-29T16:00:00.000Z",
      actor: { kind: "system", id: "terminus-control" },
      correlationId: "task-1",
      causationId: null,
      idempotencyKey: null,
      payload: {},
      artifactRefs: [],
      traceId: null,
    };
    act(() => {
      for (const handler of handlers.get("message") ?? []) handler(event);
      vi.advanceTimersByTime(200);
    });

    expect(refreshAll).toHaveBeenCalledOnce();
    view.unmount();
    expect(stream.close).toHaveBeenCalledOnce();
  });

  test("counts the tasks that want a human", () => {
    const bridge = installBridge();
    install([task("a", "NEEDS_USER_DECISION"), task("b", "ACTIVE"), task("c", "FAILED")]);

    render(<Probe />);

    // Running tasks are not a problem to be solved; blocked and failed are.
    expect(bridge.setAttentionCount).toHaveBeenLastCalledWith(2);
  });

  test("clears the badge when the queue empties", () => {
    const bridge = installBridge();
    install([task("a", "NEEDS_USER_DECISION")]);
    render(<Probe />);

    act(() => install([task("a", "ACTIVE")]));

    expect(bridge.setAttentionCount).toHaveBeenLastCalledWith(0);
  });

  test("does not repeat an unchanged count", () => {
    const bridge = installBridge();
    install([task("a", "NEEDS_USER_DECISION")]);
    render(<Probe />);
    const callsAfterMount = bridge.setAttentionCount.mock.calls.length;

    // Same count, different task: the badge has nothing new to say.
    act(() => install([task("b", "NEEDS_USER_DECISION")]));

    expect(bridge.setAttentionCount.mock.calls).toHaveLength(callsAfterMount);
  });

  test("works without a native shell", () => {
    install([task("a", "NEEDS_USER_DECISION")]);
    expect(() => render(<Probe />)).not.toThrow();
  });
});

describe("notifications", () => {
  test("announces a task that has just started waiting", () => {
    const bridge = installBridge();
    install([task("a", "ACTIVE")]);
    render(<Probe />);

    act(() => install([task("a", "NEEDS_USER_DECISION", {
      contract: {
        version: 1,
        objective: "Ship the parser fix",
        non_goals: [],
        allowed_scope: { read_paths: [], write_paths: [], external_systems: [] },
      },
    })]));

    expect(bridge.notify).toHaveBeenCalledOnce();
    // The title is what the task wants, not what state it is in. "Needs you"
    // on a lock screen makes someone switch windows to find out whether it was
    // worth switching windows; "Waiting on your answer" does not.
    expect(bridge.notify).toHaveBeenCalledWith("Waiting on your answer", "Ship the parser fix", "a");
  });

  test("says nothing about what was already waiting when the app opened", () => {
    const bridge = installBridge();
    install([task("a", "NEEDS_USER_DECISION")]);

    render(<Probe />);

    // Otherwise every launch fires a burst of notifications for old news.
    expect(bridge.notify).not.toHaveBeenCalled();
  });

  test("announces each task once, not on every store update", () => {
    const bridge = installBridge();
    install([task("a", "ACTIVE")]);
    render(<Probe />);

    act(() => install([task("a", "FAILED")]));
    act(() => install([task("a", "FAILED"), task("b", "ACTIVE")]));

    expect(bridge.notify).toHaveBeenCalledOnce();
  });

  test("announces a task again if it needs you a second time", () => {
    const bridge = installBridge();
    install([task("a", "ACTIVE")]);
    render(<Probe />);

    act(() => install([task("a", "NEEDS_USER_DECISION")]));
    act(() => install([task("a", "ACTIVE")]));
    act(() => install([task("a", "NEEDS_USER_DECISION")]));

    expect(bridge.notify).toHaveBeenCalledTimes(2);
  });

  test("stays quiet while the user is already looking at the app", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const bridge = installBridge();
    install([task("a", "ACTIVE")]);
    render(<Probe />);

    act(() => install([task("a", "NEEDS_USER_DECISION")]));

    // The badge still updates; only the interruption is suppressed.
    expect(bridge.notify).not.toHaveBeenCalled();
    expect(bridge.setAttentionCount).toHaveBeenLastCalledWith(1);
  });

  // The successful ending was the one outcome the app never mentioned, which
  // is the outcome the operator walked away waiting for.
  test("announces a task that has just finished", () => {
    const bridge = installBridge();
    install([task("a", "ACTIVE")]);
    render(<Probe />);

    act(() => install([task("a", "COMPLETED", {
      completed_at: "2026-08-28T01:00:00.000Z",
      contract: {
        version: 1,
        objective: "Ship the parser fix",
        non_goals: [],
        allowed_scope: { read_paths: [], write_paths: [], external_systems: [] },
      },
    })]));

    expect(bridge.notify).toHaveBeenCalledWith("Done", "Ship the parser fix", "a");
  });

  test("says nothing about tasks that were already finished at launch", () => {
    const bridge = installBridge();
    install([task("a", "COMPLETED", { completed_at: "2026-08-28T01:00:00.000Z" })]);

    render(<Probe />);

    expect(bridge.notify).not.toHaveBeenCalled();
  });

  test("does not re-announce on the next change once the window is focused", () => {
    const bridge = installBridge();
    install([task("a", "ACTIVE")]);
    render(<Probe />);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    act(() => install([task("a", "NEEDS_USER_DECISION")]));
    act(() => install([task("a", "NEEDS_USER_DECISION"), task("b", "ACTIVE")]));

    expect(bridge.notify).not.toHaveBeenCalled();
  });
});

describe("clicking a notification", () => {
  test("opens the task it was about", () => {
    const bridge = installBridge();
    const onOpenTask = vi.fn();
    render(<Probe onOpenTask={onOpenTask} />);

    act(() => bridge.deliverOpenTask?.("task-7"));

    expect(onOpenTask).toHaveBeenCalledWith("task-7");
  });

  test("stops listening when the app unmounts", () => {
    const bridge = installBridge();
    const view = render(<Probe />);

    view.unmount();

    expect(bridge.deliverOpenTask).toBeUndefined();
  });
});
