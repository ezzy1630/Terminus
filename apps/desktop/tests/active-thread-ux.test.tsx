import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ThreadHeader } from "../src/components/ThreadHeader";
import { InterventionTray } from "../src/components/InterventionTray";
import type { TaskPresentation } from "../src/lib/task-presentation";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: { ...actual.api, resolveApproval: vi.fn(async () => undefined) } };
});

vi.mock("../src/lib/api-v2", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api-v2")>("../src/lib/api-v2");
  return {
    ...actual,
    arpV2: {
      ...actual.arpV2,
      listMaterialQuestions: vi.fn(async () => []),
    },
  };
});

afterEach(() => cleanup());

function presentation(overrides: Partial<TaskPresentation> = {}): TaskPresentation {
  return {
    objective: "Fix the refresh-token race",
    lifecycle: "working",
    stateLabel: "Working",
    currentDetail: "Running focused tests",
    elapsedSeconds: 134,
    runActive: true,
    needsAttention: false,
    changes: { files: 3, additions: 12, deletions: 4, source: "workspace" },
    verification: { passed: 5, failed: 1, skipped: 0, running: 0, total: 6 },
    activeSubagents: 2,
    totalSubagents: 2,
    ...overrides,
  };
}

describe("ThreadHeader", () => {
  test("shows the authoritative summary and only actions with real callbacks", async () => {
    const onOpenChanges = vi.fn();
    const onStop = vi.fn();
    render(
      <ThreadHeader
        presentation={presentation()}
        repository="Terminus"
        workspace="auth-refresh-worktree"
        onOpenChanges={onOpenChanges}
        onStop={onStop}
      />,
    );

    expect(screen.getByRole("heading", { name: "Fix the refresh-token race" })).toBeInTheDocument();
    expect(screen.getByText("Running focused tests")).toBeInTheDocument();
    expect(screen.getByText("2m 14s")).toBeInTheDocument();
    expect(screen.getByText("3 files changed")).toBeInTheDocument();
    expect(screen.getByText("1 check failed")).toBeInTheDocument();
    expect(screen.getByText("2 subagents active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in Editor" })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Changes" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onOpenChanges).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
  });
});

describe("InterventionTray", () => {
  test("uses the existing approval authority and disables decisions for stale snapshots", async () => {
    render(
      <InterventionTray
        taskId="task-1"
        approvalState="stale"
        approvalError="refresh failed"
        approvals={[{
          id: "approval-1",
          action: "Run focused tests",
          operationHash: "sha256:abc",
          operation: "npm test -- auth-refresh",
          risk: "normal",
          canPersist: false,
          supportedDecisions: ["allow_once", "deny_once"],
          authorizationReady: true,
        }]}
      />,
    );

    expect(screen.getByTestId("intervention-approvals")).toBeInTheDocument();
    expect(screen.getByText(/snapshot is stale/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Allow once/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Deny once/ })).toBeDisabled();
    await waitFor(() => expect(screen.queryByText(/material question/i)).not.toBeInTheDocument());
  });
});
