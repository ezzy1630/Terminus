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
  taskStatusLabel,
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

  test("does not call unstarted work running", () => {
    // The board and the sidebar disagreed here: DRAFT and READY were placed in
    // the running column while the sidebar rendered the same task as "Queued".
    expect(boardColumnForStatus("DRAFT")).toBe("queued");
    expect(boardColumnForStatus("READY")).toBe("queued");
  });

  test("projects runtime states into stable workflow columns", () => {
    expect(boardColumnForStatus("RUNNING")).toBe("working");
    expect(boardColumnForStatus("VERIFYING")).toBe("working");
    expect(boardColumnForStatus("WAITING_USER")).toBe("needs_you");
    expect(boardColumnForStatus("WAITING_AUTH")).toBe("needs_you");
    expect(boardColumnForStatus("WAITING_RESOURCE")).toBe("needs_you");
    expect(boardColumnForStatus("BLOCKED")).toBe("needs_you");
    expect(boardColumnForStatus("PAUSED")).toBe("needs_you");
    expect(boardColumnForStatus("PARTIAL")).toBe("review");
    expect(boardColumnForStatus("COMPLETED")).toBe("done");
  });

  test("puts failures in front of the human instead of filing them as review or done", () => {
    expect(boardColumnForStatus("FAILED")).toBe("needs_you");
  });

  test("does not call cancelled work done, nor hide it off the board", () => {
    // Cancelled work used to land in a hidden "closed" bucket. It now sits in
    // Done, which is visible, and is still distinguishable by its label.
    expect(boardColumnForStatus("CANCELLED")).toBe("done");
    expect(taskStatusLabel("CANCELLED")).toBe("Cancelled");
    expect(taskStatusLabel("COMPLETED")).toBe("Done");
  });

  test("maps only lawful direct drops to canonical transitions", () => {
    expect(boardTransitionForDrop("READY", "working")).toBe("RUNNING");
    expect(boardTransitionForDrop("VERIFYING", "working")).toBe("RUNNING");
    expect(boardTransitionForDrop("PAUSED", "working")).toBe("RUNNING");
    expect(boardTransitionForDrop("BLOCKED", "working")).toBe("RUNNING");
  });

  test("refuses drops the state machine does not admit", () => {
    // DRAFT and READY share the queued column, so the drop moves nothing.
    expect(boardTransitionForDrop("DRAFT", "queued")).toBeNull();
    expect(boardTransitionForDrop("READY", "queued")).toBeNull();
    // Completion is evidence-only.
    expect(boardTransitionForDrop("RUNNING", "done")).toBeNull();
    expect(boardTransitionForDrop("VERIFYING", "done")).toBeNull();
    expect(boardTransitionForDrop("COMPLETED", "working")).toBeNull();
    // Attention is observed, never assigned by dragging a card into it.
    expect(boardTransitionForDrop("RUNNING", "needs_you")).toBeNull();
    expect(boardTransitionForDrop("READY", "needs_you")).toBeNull();
  });

  test("never admits a drop that would bounce the card out of the target column", () => {
    // Review has no inbound transition: VERIFYING is unattended agent work and
    // is projected into Working, so accepting the drop would move the card away
    // from where the user released it.
    for (const status of ["DRAFT", "READY", "RUNNING", "PAUSED", "BLOCKED", "VERIFYING"] as const) {
      const target = boardTransitionForDrop(status, "review");
      expect(target).toBeNull();
    }
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
    expect(taskNeedsAttention(task("task-resource", "WAITING_RESOURCE", "Resource task"), [])).toBe(true);
    expect(taskNeedsAttention(task("task-failed", "FAILED", "Failed task"), [])).toBe(true);
    expect(taskNeedsAttention(task("task-done", "COMPLETED", "Done task"), [])).toBe(false);
  });
});

describe("MissionBoardView", () => {
  test("renders canonical tasks, attention, cancelled work, and a persistent quick view", async () => {
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
    expect(screen.getByText("Discard obsolete migration")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Closed work/ })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByRole("table", { name: "Mission board tasks" })).toBeInTheDocument();
    const runningRow = screen.getByRole("row", { name: /Repair OAuth callback/ });
    expect(runningRow.tagName).toBe("DIV");
    expect(runningRow).toContainElement(screen.getByRole("button", { name: "Repair OAuth callback" }));
    await user.click(screen.getByRole("button", { name: "Board view" }));

    const boardGrid = screen.getByTestId("mission-board-grid");
    // One column per stage, always on one row: an auto-fit track count would
    // wrap Done underneath Queued at ordinary window widths.
    expect(boardGrid).toHaveStyle({ gridTemplateColumns: "repeat(5, minmax(200px, 1fr))" });

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
    // Working is the only column that admits a drop, so resuming a paused task
    // by dragging it there is the lawful transition to exercise.
    const pausedTask = task("task-paused", "PAUSED", "Repair OAuth callback", 7);
    const runningTask = { ...pausedTask, status: "RUNNING" as const, version: 8 };
    vi.spyOn(arpV2, "listTasks")
      .mockResolvedValueOnce([pausedTask])
      .mockResolvedValue([runningTask]);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue(inertStream());
    const transition = vi.spyOn(arpV2, "transitionTask").mockResolvedValue(runningTask);

    render(<MissionBoardView onOpenTask={() => {}} onInspectTask={() => {}} />);
    const card = await screen.findByTestId("mission-board-card-task-paused");
    const workingColumn = screen.getByTestId("mission-board-column-working");

    fireEvent.dragStart(card);
    fireEvent.dragOver(workingColumn);
    fireEvent.drop(workingColumn);

    await waitFor(() => expect(transition).toHaveBeenCalledWith(
      "task-paused",
      "RUNNING",
      { idempotencyKey: expect.any(String) },
      7,
    ));
    expect(await screen.findByText("Moved Repair OAuth callback to Working.")).toBeInTheDocument();
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
    // READY has not started, so it waits in Queued until the runtime picks it up.
    expect(await screen.findByTestId("mission-board-column-queued")).toHaveTextContent("Live task");

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

    // The live event moved it to RUNNING, so it crosses into Working.
    expect(await screen.findByTestId("mission-board-column-working")).toHaveTextContent("Live task");
    expect(screen.getByTestId("mission-board-column-queued")).not.toHaveTextContent("Live task");
  });
});
