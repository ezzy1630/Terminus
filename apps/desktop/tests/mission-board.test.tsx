import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MissionBoardView } from "../src/components/MissionBoardView";
import { buildDefaultCommands } from "../src/lib/command-catalog";
import {
  boardColumnForStatus,
  boardTransitionForDrop,
  directTaskActions,
  taskNeedsAttention,
} from "../src/lib/mission-board";
import * as apiV2Module from "../src/lib/api-v2";
import { arpV2 } from "../src/lib/api-v2";
import type { ArpV2EventStream } from "../src/lib/api-v2";
import type {
  ArpV2EventEnvelope,
  MaterialQuestionSnapshot,
  TaskV2Snapshot,
  TaskV2Status,
} from "../src/types/v2";

function task(id: string, status: TaskV2Status, mission: string, version = 1): TaskV2Snapshot {
  return {
    id,
    missionId: "mission-auth",
    organizationId: "org-1",
    departmentId: "department-1",
    createdBy: "operator-1",
    conversationContext: { sessionId: "session-1", threadId: "thread-1", attachedAt: "2026-08-23T12:00:00.000Z" },
    contract: {
      version: 1,
      mission,
      scope: { resources: [], allowedEffectClasses: [], excludedPathsOrSystems: [] },
      acceptance: [{ claimId: `${id}-claim`, statement: `Verify ${mission}`, evidenceRequirement: "DETERMINISTIC_TEST" }],
      constraints: { security: [], costMicros: "1000", timeoutSeconds: 60 },
      authorityCeiling: [],
      mode: "interactive",
    },
    status,
    version,
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:05:00.000Z",
    completedAt: status === "COMPLETED" ? "2026-08-23T12:05:00.000Z" : null,
  };
}

function question(taskId: string): MaterialQuestionSnapshot {
  return {
    id: `question-${taskId}`,
    taskId,
    trigger: "human_taste",
    questionText: "Choose the compatibility behavior",
    consequenceMatrix: {
      strict: "Preserve strict compatibility behavior.",
      compatible: "Accept the broader compatibility behavior.",
    },
    options: ["strict", "compatible"],
    status: "PENDING",
    suggestedOption: "strict",
    selectedOption: null,
    createdAt: "2026-08-23T12:04:00.000Z",
    resolvedAt: null,
  };
}

function inertStream(): ArpV2EventStream {
  return {
    readyState: 1,
    lastEventId: null,
    addEventListener: () => () => {},
    close: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("mission board domain mapping", () => {
  test("registers the board as an actionable desktop command", () => {
    const openMissionBoard = vi.fn();
    const command = buildDefaultCommands({ openMissionBoard })
      .find((candidate) => candidate.id === "nav.mission-board");

    expect(command?.label).toBe("Open mission board");
    command?.action();
    expect(openMissionBoard).toHaveBeenCalledOnce();
  });

  test("projects runtime states into stable workflow columns without calling cancelled work done", () => {
    expect(boardColumnForStatus("DRAFT")).toBe("running");
    expect(boardColumnForStatus("READY")).toBe("running");
    expect(boardColumnForStatus("RUNNING")).toBe("running");
    expect(boardColumnForStatus("PAUSED")).toBe("running");
    expect(boardColumnForStatus("WAITING_USER")).toBe("waiting_for_review");
    expect(boardColumnForStatus("VERIFYING")).toBe("waiting_for_review");
    expect(boardColumnForStatus("COMPLETED")).toBe("done");
    expect(boardColumnForStatus("FAILED")).toBe("waiting_for_review");
    expect(boardColumnForStatus("CANCELLED")).toBe("closed");
    expect(boardColumnForStatus("PARTIAL")).toBe("closed");
  });

  test("maps only lawful direct drops to canonical transitions", () => {
    expect(boardTransitionForDrop("DRAFT", "running")).toBeNull();
    expect(boardTransitionForDrop("READY", "running")).toBe("RUNNING");
    expect(boardTransitionForDrop("RUNNING", "waiting_for_review")).toBe("VERIFYING");
    expect(boardTransitionForDrop("VERIFYING", "running")).toBe("RUNNING");
    expect(boardTransitionForDrop("RUNNING", "done")).toBeNull();
    expect(boardTransitionForDrop("VERIFYING", "done")).toBeNull();
    expect(boardTransitionForDrop("COMPLETED", "running")).toBeNull();
  });

  test("keeps pause immediate, cancel destructive, and failed work non-actionable", () => {
    const runningActions = directTaskActions(task("task-running", "RUNNING", "Running task"));
    expect(runningActions).toContainEqual({ label: "Pause", targetStatus: "PAUSED" });
    expect(runningActions).toContainEqual({ label: "Cancel", targetStatus: "CANCELLED", destructive: true });
    expect(directTaskActions(task("task-failed", "FAILED", "Failed task"))).toEqual([]);
  });

  test("treats material questions and actionable task states as attention", () => {
    const running = task("task-running", "RUNNING", "Running task");
    expect(taskNeedsAttention(running, [])).toBe(false);
    expect(taskNeedsAttention(running, [question(running.id)])).toBe(true);
    expect(taskNeedsAttention(task("task-auth", "WAITING_AUTH", "Approval task"), [])).toBe(true);
    expect(taskNeedsAttention(task("task-resource", "WAITING_RESOURCE", "Resource task"), [])).toBe(false);
  });
});

describe("MissionBoardView", () => {
  test("renders canonical tasks, attention, closed history, and a persistent quick view", async () => {
    const tasks = [
      task("task-ready", "READY", "Add token refresh"),
      task("task-running", "RUNNING", "Repair OAuth callback"),
      task("task-done", "COMPLETED", "Audit authentication"),
      task("task-cancelled", "CANCELLED", "Discard obsolete migration"),
    ];
    vi.spyOn(arpV2, "listTasks").mockResolvedValue(tasks);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([question("task-running")]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue(inertStream());
    const onInspectTask = vi.fn();
    const onOpenTask = vi.fn();

    render(<MissionBoardView onOpenTask={onOpenTask} onInspectTask={onInspectTask} />);

    expect(await screen.findByRole("heading", { name: /^(Kanban|Sessions)/ })).toBeInTheDocument();
    expect(screen.getByText("Add token refresh")).toBeInTheDocument();
    expect(screen.getByText("Repair OAuth callback")).toBeInTheDocument();
    expect(screen.getByText("Audit authentication")).toBeInTheDocument();
    expect(screen.queryByText("Discard obsolete migration")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Closed work, 1 task/ })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByRole("table", { name: "Mission board tasks" })).toBeInTheDocument();
    const runningRow = screen.getByRole("row", { name: /Repair OAuth callback/ });
    expect(runningRow.tagName).toBe("DIV");
    expect(runningRow).toContainElement(screen.getByRole("button", { name: "Repair OAuth callback" }));
    await user.click(screen.getByRole("button", { name: "Board view" }));

    const boardGrid = screen.getByTestId("mission-board-grid");
    expect(boardGrid).toHaveStyle({ gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))" });
    expect(boardGrid).not.toHaveStyle({ minWidth: "1160px" });

    const taskButton = screen.getByRole("button", { name: "Open Repair OAuth callback" });
    await user.click(taskButton);
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-running" }));
    await user.click(screen.getByRole("button", { name: "Actions for Repair OAuth callback" }));
    await user.click(screen.getByRole("menuitem", { name: "Quick preview" }));
    const quickView = screen.getByRole("complementary", { name: "Task quick view" });
    expect(quickView).toHaveTextContent("Choose the compatibility behavior");
    expect(quickView).toHaveTextContent("Updated");
    expect(quickView).not.toHaveTextContent("Contract");
    expect(quickView).not.toHaveTextContent("Record");
    await user.click(screen.getByRole("button", { name: "Task details" }));
    expect(onInspectTask).toHaveBeenCalledWith("task-running");
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
  });

  test("distinguishes filtered-empty state from an empty canonical board", async () => {
    vi.spyOn(arpV2, "listTasks").mockResolvedValue([
      task("task-ready", "READY", "Add token refresh"),
    ]);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue(inertStream());
    const user = userEvent.setup();

    render(<MissionBoardView onOpenTask={() => {}} onInspectTask={() => {}} />);
    await user.type(await screen.findByRole("textbox", { name: "Search mission board" }), "missing task");

    expect(screen.getByRole("heading", { name: "No matching tasks" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No tasks yet" })).not.toBeInTheDocument();
    const clearButton = screen.getAllByRole("button", { name: "Clear filters" })[0];
    expect(clearButton).toBeDefined();
    await user.click(clearButton!);
    expect(screen.getByText("Add token refresh")).toBeInTheDocument();
  });

  test("executes a lawful drag transition with the card version and an idempotency key", async () => {
    const runningTask = task("task-running", "RUNNING", "Repair OAuth callback", 7);
    const verifyingTask = { ...runningTask, status: "VERIFYING" as const, version: 8 };
    vi.spyOn(arpV2, "listTasks")
      .mockResolvedValueOnce([runningTask])
      .mockResolvedValue([verifyingTask]);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue(inertStream());
    const transition = vi.spyOn(arpV2, "transitionTask").mockResolvedValue(verifyingTask);

    render(<MissionBoardView onOpenTask={() => {}} onInspectTask={() => {}} />);
    const card = await screen.findByTestId("mission-board-card-task-running");
    const waitingColumn = screen.getByTestId("mission-board-column-waiting_for_review");

    fireEvent.dragStart(card);
    fireEvent.dragOver(waitingColumn);
    fireEvent.drop(waitingColumn);

    await waitFor(() => expect(transition).toHaveBeenCalledWith(
      "task-running",
      "VERIFYING",
      { idempotencyKey: expect.any(String) },
      7,
    ));
    expect(await screen.findByText("Moved Repair OAuth callback to Waiting for review.")).toBeInTheDocument();
  });

  test("refreshes from canonical state after a relevant live event", async () => {
    const ready = task("task-live", "READY", "Live task");
    const running = { ...ready, status: "RUNNING" as const, version: 2 };
    const handlers = new Map<string, Set<(event?: ArpV2EventEnvelope) => void>>();
    const stream: ArpV2EventStream = {
      readyState: 1,
      lastEventId: null,
      addEventListener(type, handler) {
        const set = handlers.get(type) ?? new Set();
        set.add(handler as (event?: ArpV2EventEnvelope) => void);
        handlers.set(type, set);
        return () => set.delete(handler as (event?: ArpV2EventEnvelope) => void);
      },
      close: vi.fn(),
    };
    vi.spyOn(arpV2, "listTasks")
      .mockResolvedValueOnce([ready])
      .mockResolvedValue([running]);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue(stream);

    render(<MissionBoardView onOpenTask={() => {}} onInspectTask={() => {}} />);
    expect(await screen.findByTestId("mission-board-column-running")).toHaveTextContent("Live task");

    await act(async () => {
      for (const handler of handlers.get("message") ?? []) {
        handler({
          eventId: "event-1",
          eventType: "task.running",
          schemaVersion: 2,
          aggregateType: "task",
          aggregateId: ready.id,
          aggregateSequence: 2,
          occurredAt: "2026-08-23T12:06:00.000Z",
          actor: { kind: "system", id: "terminus-control" },
          correlationId: ready.id,
          causationId: null,
          idempotencyKey: null,
          payload: {},
          artifactRefs: [],
          traceId: null,
        });
      }
      await new Promise((resolve) => window.setTimeout(resolve, 180));
    });

    expect(await screen.findByTestId("mission-board-column-running")).toHaveTextContent("Live task");
  });
});
