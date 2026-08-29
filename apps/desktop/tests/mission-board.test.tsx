import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MissionBoardView } from "../src/components/MissionBoardView";
import { buildDefaultCommands } from "../src/lib/command-catalog";
import {
  attentionReason,
  attentionTone,
  boardColumnForStatus,
  boardColumnForTaskPlacement,
  boardTransitionForDrop,
  directTaskActions,
  taskEvidence,
  taskNeedsAttention,
  taskStatusLabel,
} from "../src/lib/mission-board";
import { compactDuration } from "../src/lib/time";
import { useTerminusStore } from "../src/hooks/use-terminus";
import type { Task } from "../src/types";
import * as apiV2Module from "../src/lib/api-v2";
import { arpV2 } from "../src/lib/api-v2";
import type { ArpV2EventStream } from "../src/lib/api-v2";
import type {
  ArpV2EventEnvelope,
  MaterialQuestionSnapshot,
  TaskV2Snapshot,
  TaskV2Status,
} from "../src/types/v2";

/**
 * Fixture timestamps are recent on purpose: Done folds work finished more than
 * a day ago, so a fixed 2026 date would put every completed task behind the
 * "earlier" disclosure and make unrelated assertions depend on the clock.
 */
const RECENT_ISO = new Date(Date.now() - 5 * 60_000).toISOString();

function task(id: string, status: TaskV2Status, mission: string, version = 1): TaskV2Snapshot {
  return {
    id,
    missionId: "mission-auth",
    organizationId: "org-1",
    departmentId: "department-1",
    createdBy: "operator-1",
    conversationContext: { sessionId: "session-1", threadId: "thread-1", attachedAt: RECENT_ISO },
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
    createdAt: RECENT_ISO,
    updatedAt: RECENT_ISO,
    completedAt: status === "COMPLETED" ? RECENT_ISO : null,
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

function domainTask(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    session_id: "session-1",
    thread_id: "thread-1",
    status: "ACTIVE",
    phase: "EXECUTE",
    active_contract_version: 1,
    risk_class: "normal",
    created_at: RECENT_ISO,
    updated_at: RECENT_ISO,
    completed_at: null,
    terminal_reason: null,
    contract: null,
    ...patch,
  };
}

function seedDomainTasks(tasks: readonly Task[]): void {
  useTerminusStore.setState({
    taskById: Object.fromEntries(tasks.map((task) => [task.id, task])),
    runActivityByTask: {},
  });
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
  useTerminusStore.setState({ taskById: {}, runActivityByTask: {} });
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

  test("says what the human owes rather than that something is owed", () => {
    // The whole point: ten cards under "Needs you" used to be ten identical
    // dots. Each of these is a different instruction to a person.
    const asking = task("task-asking", "RUNNING", "Running task");
    expect(attentionReason(asking, "working", undefined, [question(asking.id)]))
      .toMatchObject({ kind: "question", label: "Answer this", detail: "Choose the compatibility behavior" });
    expect(attentionReason(task("task-auth", "WAITING_AUTH", "Approval task"), "needs_you", undefined, []))
      .toMatchObject({ kind: "approval", label: "Approve or deny" });
    expect(attentionReason(task("task-paused", "PAUSED", "Paused task"), "needs_you", undefined, []))
      .toMatchObject({ kind: "paused", label: "Paused" });
  });

  test("prefers the domain status, which v2 has already flattened into FAILED", () => {
    // v1TaskStatusToV2 collapses BUDGET_EXHAUSTED and POLICY_DENIED into one
    // v2 FAILED. Reading only the v2 status would tell a person "Failed" when
    // the actual instruction is "raise the budget" or "make a call".
    const denied = task("task-denied", "FAILED", "Denied task");
    expect(attentionReason(denied, "failed", domainTask(denied.id, {
      status: "POLICY_DENIED",
      terminal_reason: { reason: "policy", message: "Writing outside the allowed scope." },
    }), [])).toMatchObject({ kind: "policy", label: "Policy denied", detail: "Writing outside the allowed scope." });

    const broke = task("task-budget", "FAILED", "Budget task");
    expect(attentionReason(broke, "failed", domainTask(broke.id, { status: "BUDGET_EXHAUSTED" }), []))
      .toMatchObject({ kind: "budget", label: "Out of budget" });
  });

  test("does not restate a column inside its own cards", () => {
    // Review's header already says the changes are ready to read.
    expect(attentionReason(task("task-partial", "PARTIAL", "Partial task"), "review", undefined, [])).toBeNull();
    expect(attentionReason(task("task-running", "RUNNING", "Running task"), "working", undefined, [])).toBeNull();
    expect(attentionReason(task("task-done", "COMPLETED", "Done task"), "done", undefined, [])).toBeNull();
  });

  test("separates broken work from work that is merely waiting on someone", () => {
    expect(attentionTone("failure")).toBe("error");
    expect(attentionTone("policy")).toBe("error");
    expect(attentionTone("budget")).toBe("error");
    expect(attentionTone("question")).toBe("warning");
    expect(attentionTone("approval")).toBe("warning");
    expect(attentionTone("paused")).toBe("warning");
  });

  test("orders the attention column by what is cheapest to discharge", () => {
    const rank = (status: TaskV2Status, lifecycle: Parameters<typeof attentionReason>[1]): number =>
      attentionReason(task(`task-${status}`, status, status), lifecycle, undefined, [])?.rank ?? Number.MAX_SAFE_INTEGER;
    expect(rank("WAITING_USER", "needs_you")).toBeLessThan(rank("WAITING_AUTH", "needs_you"));
    expect(rank("WAITING_AUTH", "needs_you")).toBeLessThan(rank("FAILED", "failed"));
    expect(rank("FAILED", "failed")).toBeLessThan(rank("PAUSED", "needs_you"));
  });

  test("pulls a running task with a pending question into the attention column", () => {
    // Otherwise the one column that exists to be the complete list of what
    // needs a human is not the complete list of what needs a human.
    expect(boardColumnForTaskPlacement("working", true)).toBe("needs_you");
    expect(boardColumnForTaskPlacement("working", false)).toBe("working");
    // A stale question must not drag finished work back out of Done.
    expect(boardColumnForTaskPlacement("done", true)).toBe("done");
    expect(boardColumnForTaskPlacement("cancelled", true)).toBe("done");
    expect(boardColumnForTaskPlacement("failed", true)).toBe("needs_you");
  });

  test("states elapsed time and spend only where the client was actually told them", () => {
    const now = Date.parse("2026-08-28T12:00:00.000Z");
    const running = domainTask("task-elapsed", {
      active_turn: { id: "turn-1", state: "RUNNING", started_at: "2026-08-28T11:48:00.000Z" },
    });
    expect(taskEvidence(running, "working", now).elapsed).toBe("12m");
    // Not running: elapsed would be the age of a turn that already ended.
    expect(taskEvidence(running, "idle", now).elapsed).toBeNull();
    // The list route omits the ledger. An unloaded task says nothing rather
    // than claiming this one was free.
    expect(taskEvidence(domainTask("task-bare"), "working", now).budget).toBeNull();
    expect(taskEvidence(undefined, "working", now)).toEqual({ elapsed: null, budget: null });
  });

  test("formats elapsed time at card width", () => {
    const now = Date.parse("2026-08-28T12:00:00.000Z");
    expect(compactDuration("2026-08-28T11:59:12.000Z", now)).toBe("48s");
    expect(compactDuration("2026-08-28T11:56:00.000Z", now)).toBe("4m");
    expect(compactDuration("2026-08-28T10:48:00.000Z", now)).toBe("1h 12m");
    expect(compactDuration("2026-08-26T12:00:00.000Z", now)).toBe("2d");
    // Clock skew against the control plane is not negative elapsed time.
    expect(compactDuration("2026-08-28T12:00:30.000Z", now)).toBe("0s");
    expect(compactDuration("not a date", now)).toBeNull();
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

  test("names the obligation on each card instead of a column of identical dots", async () => {
    const asking = task("task-question", "RUNNING", "Repair OAuth callback");
    const denied = task("task-denied", "FAILED", "Rewrite the migration");
    seedDomainTasks([domainTask("task-denied", {
      status: "POLICY_DENIED",
      terminal_reason: { reason: "policy_denied", message: "Writing outside the allowed scope." },
    })]);
    vi.spyOn(arpV2, "listTasks").mockResolvedValue([asking, denied]);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([question(asking.id)]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue(inertStream());

    render(<MissionBoardView onOpenTask={() => {}} onInspectTask={() => {}} />);

    const attention = await screen.findByTestId("mission-board-column-needs_you");
    // Each card says which of the four different things it wants.
    expect(attention).toHaveTextContent("Answer this");
    expect(attention).toHaveTextContent("Choose the compatibility behavior");
    expect(attention).toHaveTextContent("Policy denied");
    expect(attention).toHaveTextContent("Writing outside the allowed scope.");
    // The agent is still RUNNING, but what it needs is already on the table,
    // so the card is where a human looks for work rather than in Working.
    expect(attention).toHaveTextContent("Repair OAuth callback");
    expect(screen.getByTestId("mission-board-column-working")).not.toHaveTextContent("Repair OAuth callback");
    // And the header count agrees with the column instead of running its own
    // parallel attention arithmetic.
    expect(screen.getByRole("button", { name: /Show only the 2 tasks that need you/ })).toBeInTheDocument();
  });

  test("folds finished work older than a day rather than letting Done grow forever", async () => {
    const stale = {
      ...task("task-stale", "COMPLETED", "Audit authentication"),
      completedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString(),
    };
    vi.spyOn(arpV2, "listTasks").mockResolvedValue([stale, task("task-fresh", "COMPLETED", "Ship token refresh")]);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue(inertStream());
    const user = userEvent.setup();

    render(<MissionBoardView onOpenTask={() => {}} onInspectTask={() => {}} />);

    const done = await screen.findByTestId("mission-board-column-done");
    expect(done).toHaveTextContent("Ship token refresh");
    expect(done).not.toHaveTextContent("Audit authentication");
    // Folded, not hidden: the count is the affordance and one click undoes it.
    await user.click(screen.getByRole("button", { name: "1 earlier" }));
    expect(done).toHaveTextContent("Audit authentication");
  });

  test("crosses the board with the arrow keys and opens with Enter", async () => {
    const onOpenTask = vi.fn();
    vi.spyOn(arpV2, "listTasks").mockResolvedValue([
      task("task-a", "READY", "Add token refresh"),
      task("task-b", "READY", "Rotate the signing key"),
      task("task-c", "COMPLETED", "Audit authentication"),
    ]);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue(inertStream());

    render(<MissionBoardView onOpenTask={onOpenTask} onInspectTask={() => {}} />);

    const first = await screen.findByTestId("mission-board-card-task-a");
    // One tab stop for the whole board, then arrows.
    expect(first).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("mission-board-card-task-b")).toHaveAttribute("tabindex", "-1");

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByTestId("mission-board-card-task-b")).toHaveFocus();

    // Working, Needs you and Review are all empty. An empty column must not
    // swallow the keypress and strand the user in Queued.
    fireEvent.keyDown(screen.getByTestId("mission-board-card-task-b"), { key: "ArrowRight" });
    const done = screen.getByTestId("mission-board-card-task-c");
    expect(done).toHaveFocus();

    fireEvent.keyDown(done, { key: "Enter" });
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-c" }));

    fireEvent.keyDown(done, { key: " " });
    expect(screen.getByRole("complementary", { name: "Task quick view" })).toBeInTheDocument();
  });

  test("gives the mouse every route the keyboard has", async () => {
    const onOpenTask = vi.fn();
    vi.spyOn(arpV2, "listTasks").mockResolvedValue([task("task-mouse", "READY", "Add token refresh")]);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue(inertStream());
    const user = userEvent.setup();

    render(<MissionBoardView onOpenTask={onOpenTask} onInspectTask={() => {}} />);
    const card = await screen.findByTestId("mission-board-card-task-mouse");

    // Clicking the body previews, the same as Space. The card body used to be
    // dead space: only the title and the overflow trigger did anything.
    await user.click(card);
    expect(screen.getByRole("complementary", { name: "Task quick view" })).toBeInTheDocument();
    expect(onOpenTask).not.toHaveBeenCalled();
    // And it takes keyboard focus, so the arrows work from wherever the mouse
    // left off rather than from wherever Tab last was.
    expect(card).toHaveFocus();

    // Double click opens, the same as Enter.
    await user.dblClick(card);
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-mouse" }));
  });

  test("does not treat a click on the card's own controls as a click on the card", async () => {
    const onOpenTask = vi.fn();
    vi.spyOn(arpV2, "listTasks").mockResolvedValue([task("task-controls", "READY", "Add token refresh")]);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue(inertStream());
    const user = userEvent.setup();

    render(<MissionBoardView onOpenTask={onOpenTask} onInspectTask={() => {}} />);
    await screen.findByTestId("mission-board-card-task-controls");

    // The title opens rather than previewing, even though the card underneath
    // it previews on click.
    await user.click(screen.getByRole("button", { name: "Open Add token refresh" }));
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-controls" }));
    expect(screen.queryByRole("complementary", { name: "Task quick view" })).not.toBeInTheDocument();
  });

  test("offers the card actions on right click as well as from the overflow trigger", async () => {
    vi.spyOn(arpV2, "listTasks").mockResolvedValue([task("task-menu", "READY", "Add token refresh")]);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue(inertStream());

    render(<MissionBoardView onOpenTask={() => {}} onInspectTask={() => {}} />);
    const card = await screen.findByTestId("mission-board-card-task-menu");

    fireEvent.contextMenu(card);

    const menu = await screen.findByRole("menu");
    expect(menu).toHaveTextContent("Open conversation");
    expect(menu).toHaveTextContent("Start");
    expect(menu).toHaveTextContent("Cancel");
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
