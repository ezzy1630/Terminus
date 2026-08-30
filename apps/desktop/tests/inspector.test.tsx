import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inspector } from "../src/components/Inspector";
import { useTerminusStore } from "../src/hooks/use-terminus";
import { api } from "../src/lib/api";
import { arpV2 } from "../src/lib/api-v2";
import type { SandboxReport, Task, TerminusSseEvent } from "../src/types";

const task: Task = {
  id: "task-1",
  session_id: "session-1",
  thread_id: "thread-1",
  status: "ACTIVE",
  phase: "EXECUTING",
  active_contract_version: 1,
  risk_class: "normal",
  created_at: "2026-07-13T00:00:00.000Z",
  updated_at: "2026-07-13T00:00:00.000Z",
  completed_at: null,
  terminal_reason: null,
  contract: null,
};

function event(id: string, eventName: string, payload: Record<string, unknown>): TerminusSseEvent {
  return { id, event: eventName, data: JSON.stringify(payload) };
}

describe("Inspector relevance", () => {
  beforeEach(() => {
    useTerminusStore.setState({
      sessions: [],
      selectedTaskId: task.id,
      taskById: { [task.id]: task },
      eventsByTask: { [task.id]: [] },
      healthStatus: "ready",
      healthReady: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("omits task groups that have no supporting runtime evidence", () => {
    render(<Inspector />);

    expect(screen.getByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.queryByText("Context Compiler")).not.toBeInTheDocument();
    for (const name of ["Environment", "Activity", "Approvals"]) {
      expect(screen.queryByRole("heading", { name })).not.toBeInTheDocument();
    }
    for (const name of ["Changes", "Subagents", "Verification", "Computer Use"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  test("reveals evidence-backed sections and opens the real review action", async () => {
    const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new";
    useTerminusStore.setState({
      eventsByTask: {
        [task.id]: [
          event("1", "tool.settled", { tool: "patch", result: { patch: diff } }),
          event("2", "agent.spawned", { agentId: "agent-1", role: "Review UI" }),
          event("3", "verification.node_passed", { nodeId: "desktop-unit" }),
          event("4", "approval.requested", { approvalId: "approval-1", operationSummary: "Apply changes", risk: "normal" }),
        ],
      },
      eventHistoryByTask: {},
    });
    const onShowChanges = vi.fn();
    render(
      <Inspector
        onShowChanges={onShowChanges}
      />,
    );

    expect(screen.getByText("Subagents")).toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeInTheDocument();
    expect(screen.getByText("Verification")).toBeInTheDocument();
    expect(screen.getByText("1/1 passed")).toBeInTheDocument();
    // Blocking approvals moved to the intervention tray above the composer;
    // the details drawer must not duplicate the same authority.
    expect(screen.queryByRole("heading", { name: "Approvals" })).not.toBeInTheDocument();
    const changes = screen.getByRole("button", { name: "Open changes review" });
    expect(changes).toHaveTextContent("1 file");
    expect(screen.queryByRole("button", { name: "Computer Use" })).not.toBeInTheDocument();

    await userEvent.setup().click(changes);
    expect(onShowChanges).toHaveBeenCalledTimes(1);
  });

  test("keeps raw protocol fields behind Evidence advanced details", async () => {
    vi.spyOn(arpV2, "getTask").mockResolvedValue(null);
    const user = userEvent.setup();
    render(<Inspector />);

    expect(screen.queryByText("Risk class")).not.toBeInTheDocument();
    expect(screen.queryByText("Contract")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Evidence" }));
    expect(screen.queryByText("Risk class")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Advanced details, Protocol and receipts/ }));
    expect(screen.getByText("Risk class")).toBeInTheDocument();
    expect(screen.getByText("Contract")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy task ID" })).toBeInTheDocument();
  });

  test("keeps the last sandbox report visibly stale when a manual refresh fails", async () => {
    const report: SandboxReport = {
      backend_id: "seatbelt-v1",
      status: "enforced",
      enforced: ["filesystem"],
      degraded: [],
      unsupported: [],
      notes: [],
    };
    let rejectRefresh: (reason: unknown) => void = () => undefined;
    vi.spyOn(api, "getSandboxReport")
      .mockResolvedValueOnce(report)
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectRefresh = reject; }));
    useTerminusStore.setState({
      sessions: [{
        id: task.session_id,
        workspace_id: "workspace-1",
        title: "Terminus",
        status: "active",
        default_permission_profile: "secure-local-default",
        active_thread_id: null,
        created_at: "2026-07-13T00:00:00.000Z",
        updated_at: "2026-07-13T00:00:00.000Z",
      }],
    });
    const user = userEvent.setup();
    render(<Inspector />);

    await user.click(screen.getByRole("tab", { name: "Environment" }));
    await user.click(await screen.findByRole("button", { name: /^(Sandbox|Permissions), Enforced/ }));
    expect(screen.getByText("seatbelt-v1")).toBeInTheDocument();
    const refresh = screen.getByRole("button", { name: "Refresh sandbox snapshot" });
    await user.click(refresh);
    await waitFor(() => expect(refresh).toBeDisabled());
    expect(refresh).toHaveTextContent("Refreshing");

    await act(async () => {
      rejectRefresh(new Error("kernel report timed out"));
      await Promise.resolve();
    });
    expect(await screen.findByText(/Showing the last confirmed enforcement snapshot/)).toHaveTextContent("kernel report timed out");
    expect(screen.getByText("seatbelt-v1")).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="stale"]')).toBeInTheDocument();
  });

  test("retries a transient canonical-task probe failure", async () => {
    vi.spyOn(arpV2, "getTask")
      .mockRejectedValueOnce(new Error("canonical probe timed out"))
      .mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<Inspector />);

    await user.click(screen.getByRole("tab", { name: "Evidence" }));
    await user.click(screen.getByRole("button", { name: /Advanced details, Protocol and receipts/ }));
    expect(await screen.findByText("canonical probe timed out")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Retry (task record|canonical task)/ }));
    await waitFor(() => expect(arpV2.getTask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Retry (task record|canonical task)/ })).not.toBeInTheDocument());
  });
});
