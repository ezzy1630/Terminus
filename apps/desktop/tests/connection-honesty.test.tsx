/**
 * The client says what it actually knows about the connection.
 *
 * Three separate lies were in place: the connection banner existed but was
 * never mounted, so an offline control plane showed as an empty sidebar; the
 * liveness probe ran once and never again, so a client that started first said
 * "still starting" forever; and Send was disabled on `healthReady`, which is
 * derived from `/v1/system/health` — an endpoint that stops answering while a
 * turn holds the writer lease, i.e. exactly when steering matters.
 */
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ConnectionBanner } from "../src/components/ConnectionBanner";
import { Composer } from "../src/components/Composer";
import {
  HEALTH_HEARTBEAT_MS,
  HEALTH_RETRY_MIN_MS,
  useHealthMonitor,
  useTerminusStore,
} from "../src/hooks/use-terminus";
import { api } from "../src/lib/api";
import type { Task } from "../src/types";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      health: vi.fn(),
      startTask: vi.fn(async () => ({ task_id: "task-1", status: "ACTIVE", event_cursor: "c1", links: { events: "", task: "" } })),
      startTurn: vi.fn(async () => ({})),
      listProviderModels: vi.fn(async () => ({ providers: [], models: [] })),
    },
  };
});

const now = new Date().toISOString();

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    session_id: "session-1",
    thread_id: "thread-1",
    status: "DRAFT",
    phase: "EXECUTE",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: now,
    updated_at: now,
    completed_at: null,
    terminal_reason: null,
    contract: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  useTerminusStore.setState({
    healthStatus: "unknown",
    healthReady: false,
    healthDetail: null,
    lastError: null,
    streamState: "idle",
    sessionsFreshness: { status: "ready", error: null },
    taskListFreshnessBySession: {},
    taskFreshnessById: {},
    approvalFreshnessByTask: {},
    selectedSessionId: null,
    selectedTaskId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the health probe keeps asking", () => {
  test("retries quickly while the control plane is down and settles once it answers", async () => {
    vi.useFakeTimers();
    const health = vi.mocked(api.health);
    health.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    health.mockResolvedValue({ status: "ok", ready: true, kernel: null } as never);

    renderHook(() => useHealthMonitor());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(health).toHaveBeenCalledTimes(1);
    expect(useTerminusStore.getState().healthStatus).toBe("offline");

    // A client that started before the control plane must notice it arrive.
    await act(async () => { await vi.advanceTimersByTimeAsync(HEALTH_RETRY_MIN_MS); });
    expect(health).toHaveBeenCalledTimes(2);
    expect(useTerminusStore.getState().healthStatus).toBe("ready");

    // Healthy means a heartbeat, not a hot loop.
    await act(async () => { await vi.advanceTimersByTimeAsync(HEALTH_RETRY_MIN_MS * 4); });
    expect(health).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(HEALTH_HEARTBEAT_MS); });
    expect(health).toHaveBeenCalledTimes(3);
  });
});

describe("the banner", () => {
  test("names the control plane as offline instead of showing an empty window", () => {
    useTerminusStore.setState({
      healthStatus: "offline",
      healthDetail: "fetch failed: connect ECONNREFUSED 127.0.0.1:3050",
    });
    render(<ConnectionBanner />);

    expect(screen.getByTestId("connection-banner")).toBeInTheDocument();
    expect(screen.getByText(/connect ECONNREFUSED/)).toBeInTheDocument();
  });

  test("keeps the transport's reason for a dropped stream", () => {
    useTerminusStore.setState({
      healthStatus: "ready",
      healthReady: true,
      streamState: "reconnecting",
      lastError: "Live updates interrupted — the event stream was refused with HTTP 503. Reconnecting…",
    });
    render(<ConnectionBanner />);

    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
  });

  test("shows nothing at all when everything is healthy", () => {
    useTerminusStore.setState({ healthStatus: "ready", healthReady: true, streamState: "connected" });
    const { container } = render(<ConnectionBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Send is not gated on the liveness probe", () => {
  test("the request goes out and the real failure is what the user sees", async () => {
    useTerminusStore.setState({
      healthReady: false,
      healthStatus: "degraded",
      selectedSessionId: "session-1",
      selectedTaskId: "task-1",
      taskById: { "task-1": task() },
      tasksBySession: { "session-1": [task()] },
      eventsByTask: {},
      queuedSteerByTask: {},
      draftsByTask: {},
      sessionDraftsByTask: {},
    });
    vi.mocked(api.startTurn).mockRejectedValueOnce(new Error("service unavailable"));
    const user = userEvent.setup();
    render(<Composer />);

    const box = screen.getByRole("textbox", { name: "Message composer" });
    await user.type(box, "steer this");
    const send = screen.getByRole("button", { name: /^Send/ });
    // The old build disabled this button outright, so the user could not even
    // find out what was wrong.
    expect(send).not.toBeDisabled();
    await user.click(send);

    expect(await screen.findByRole("alert")).toHaveTextContent("service unavailable");
  });
});
