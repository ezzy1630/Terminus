import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "../src/App";
import { AgentsView } from "../src/components/AgentsView";
import { AttentionCenterModal } from "../src/components/Cockpit/AttentionCenterModal";
import { CausalReplayView } from "../src/components/Cockpit/CausalReplayView";
import { DepartmentRoomsView } from "../src/components/Cockpit/DepartmentRoomsView";
import { EffectQueueView } from "../src/components/Cockpit/EffectQueueView";
import { StructuredInterventionModal } from "../src/components/Cockpit/StructuredInterventionModal";
import { WorkflowGraphView } from "../src/components/Cockpit/WorkflowGraphView";
import { buildDefaultCommands } from "../src/lib/command-catalog";
import { Sidebar } from "../src/components/Sidebar";
import { useTerminusStore } from "../src/hooks/use-terminus";
import { api, TerminusApiError } from "../src/lib/api";
import * as apiV2Module from "../src/lib/api-v2";
import {
  arpV2,
  decodeAttentionAssessment,
  decodeTaskBudget,
  MAX_ARP_COLLECTION_ITEMS,
  TerminusArpV2Client,
} from "../src/lib/api-v2";
import type {
  AgentRoomSnapshot,
  AttentionAssessmentSnapshot,
  CausalReplayTraceSnapshot,
  CounterfactualExperimentSnapshot,
  DepartmentSnapshot,
  MaterialQuestionSnapshot,
  OperatorAgentSnapshot,
  OrganizationSnapshot,
  StructuredInterventionSnapshot,
  TaskV2Snapshot,
} from "../src/types/v2";

const originalRefreshAll = useTerminusStore.getState().refreshAll;

const ROOM: AgentRoomSnapshot = {
  id: "room-1",
  departmentId: "department-1",
  name: "Verification room",
  operatorId: "operator-1",
  activeWorkerIds: ["worker-1"],
  specialistIds: [],
  reviewerIds: ["reviewer-1"],
  supervisorId: null,
  createdAt: "2026-08-23T12:00:00.000Z",
};

const ORGANIZATION: OrganizationSnapshot = {
  id: "organization-1",
  displayName: "Terminus",
  rootPolicyProfile: "root-policy",
  createdAt: "2026-08-23T12:00:00.000Z",
};

const DEPARTMENT: DepartmentSnapshot = {
  id: "department-1",
  organizationId: ORGANIZATION.id,
  displayName: "Platform",
  policyProfile: "platform-policy",
  defaultOperatorId: "operator-1",
  createdAt: "2026-08-23T12:00:00.000Z",
};

const OPERATOR: OperatorAgentSnapshot = {
  id: "operator-1",
  departmentId: DEPARTMENT.id,
  displayName: "Build operator",
  capabilityScope: ["repository.read", "repository.write"],
  modelProfile: "coding-default",
  active: true,
};

const QUESTION: MaterialQuestionSnapshot = {
  id: "question-1",
  taskId: "task-1",
  trigger: "irreversible_effect",
  questionText: "Publish the release artifact?",
  consequenceMatrix: {
    Publish: "The artifact becomes externally visible.",
    Hold: "The release remains private.",
  },
  options: ["Publish", "Hold"],
  status: "PENDING",
  suggestedOption: null,
  selectedOption: null,
  createdAt: "2026-08-23T12:00:00.000Z",
  resolvedAt: null,
};

const ASSESSMENT: AttentionAssessmentSnapshot = {
  taskId: "task-1",
  requiresAttention: true,
  urgency: "BLOCKING",
  pendingQuestions: [QUESTION],
  reason: "An irreversible effect requires an operator decision.",
  timestamp: "2026-08-23T12:00:00.000Z",
};

const CAUSAL_TRACE: CausalReplayTraceSnapshot = {
  id: "trace-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  pinnedInputsHash: "sha256:pinned",
  steps: [],
  divergencePoints: [],
  omissionDiagnostics: [],
  createdAt: "2026-08-23T12:00:00.000Z",
};

const COUNTERFACTUAL: CounterfactualExperimentSnapshot = {
  id: "experiment-1",
  sourceTaskId: "task-1",
  variationType: "profile",
  variationDetails: { profileId: "profile-b" },
  executionStatus: "completed",
  predictedOutcome: "The evaluator predicts a different path.",
  actualOutcome: null,
  deltaSuccess: null,
  deltaCostMicros: null,
  deltaLatencyMs: null,
};

const CANONICAL_TASK: TaskV2Snapshot = {
  id: "canonical-task-1",
  missionId: "mission-ui",
  organizationId: "organization-1",
  departmentId: "department-1",
  createdBy: "operator-1",
  conversationContext: null,
  contract: {
    version: 1,
    mission: "Polish the desktop UI",
    scope: { resources: [], allowedEffectClasses: [], excludedPathsOrSystems: [] },
    acceptance: [],
    constraints: { security: [], costMicros: "1000", timeoutSeconds: 60 },
    authorityCeiling: [],
    mode: "interactive",
  },
  status: "RUNNING",
  version: 1,
  createdAt: "2026-08-23T12:00:00.000Z",
  updatedAt: "2026-08-23T12:05:00.000Z",
  completedAt: null,
};

function resetStore(): void {
  useTerminusStore.setState({
    healthReady: true,
    lastError: null,
    streamState: "idle",
    sessions: [],
    tasksBySession: {},
    taskById: {},
    selectedSessionId: null,
    selectedTaskId: null,
    pinnedTaskIds: new Set(),
    draftsByTask: {},
    eventsByTask: {},
    approvalsByTask: {},
    loadingSessions: false,
    loadingTasksFor: null,
    refreshAll: originalRefreshAll,
    _stream: null,
  });
}

function AttentionHarness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open attention center</button>
      {open ? <AttentionCenterModal isOpen onClose={() => setOpen(false)} /> : null}
    </>
  );
}

describe("truthful operator cockpit", () => {
  beforeEach(() => {
    resetStore();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetStore();
  });

  test("rejects malformed Phase 9 responses instead of shaping them as success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      organizations: [{ id: 42, displayName: "Malformed" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const client = new TerminusArpV2Client({ baseUrl: "http://control-plane.test", token: "" });

    await expect(client.listOrganizations()).rejects.toMatchObject({
      status: 502,
      message: "organization.id was not a non-empty string",
    });
  });

  test("rejects hostile budget counters and oversized ARP collections before render", () => {
    const budget = {
      taskId: "task-budget",
      consumedCostMicros: "1",
      consumedComputeSeconds: 1,
      consumedInputTokens: "2",
      consumedOutputTokens: "3",
      consumedApprovals: 0,
      lastUpdatedAt: "2026-08-23T12:00:00.000Z",
    };

    expect(() => decodeTaskBudget({ ...budget, consumedCostMicros: "-1" })).toThrow(/was negative/);
    expect(() => decodeTaskBudget({ ...budget, consumedInputTokens: "9".repeat(79) })).toThrow(/exceeded 78 decimal digits/);
    expect(() => decodeTaskBudget({ ...budget, consumedComputeSeconds: -0.5 })).toThrow(/was negative/);
    expect(() => decodeTaskBudget({ ...budget, consumedApprovals: -1 })).toThrow(/was negative/);
    expect(() => decodeAttentionAssessment({
      taskId: "task-budget",
      requiresAttention: false,
      urgency: "NONE",
      pendingQuestions: Array.from({ length: MAX_ARP_COLLECTION_ITEMS + 1 }, () => ({})),
      reason: "No material question.",
      timestamp: "2026-08-23T12:00:00.000Z",
    })).toThrow(/renderer admission limit/);
  });

  test("renders API errors, unavailability, and empty collections as distinct states", async () => {
    const rooms = vi.spyOn(arpV2, "listAgentRooms")
      .mockRejectedValueOnce(new TerminusApiError(500, "directory failed", null))
      .mockRejectedValueOnce(new TerminusApiError(0, "network error: refused", null))
      .mockResolvedValueOnce([]);

    const errorRender = render(<DepartmentRoomsView />);
    expect(await screen.findByText(/Could not load operator data|Couldn't load this view/)).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="error"]')).toBeInTheDocument();
    errorRender.unmount();

    const unavailableRender = render(<DepartmentRoomsView />);
    expect(await screen.findByText(/Control plane unavailable|Terminus is offline/)).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="unavailable"]')).toBeInTheDocument();
    unavailableRender.unmount();

    render(<DepartmentRoomsView />);
    expect(await screen.findByText("No agent rooms")).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="empty"]')).toBeInTheDocument();
    expect(rooms).toHaveBeenCalledTimes(3);
  });

  test("joins server-reported organizations, departments, operators, and rooms in Agents", async () => {
    vi.spyOn(arpV2, "listOrganizations").mockResolvedValue([ORGANIZATION]);
    vi.spyOn(arpV2, "listDepartments").mockResolvedValue([DEPARTMENT]);
    vi.spyOn(arpV2, "listOperators").mockResolvedValue([OPERATOR]);
    vi.spyOn(arpV2, "listAgentRooms").mockResolvedValue([ROOM]);
    const user = userEvent.setup();

    render(<AgentsView />);

    expect(screen.getByRole("status", { name: "Loading agents" })).toBeInTheDocument();
    expect(screen.queryByText("No agent selected")).not.toBeInTheDocument();
    expect((await screen.findAllByText(OPERATOR.displayName)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(DEPARTMENT.displayName).length).toBeGreaterThan(0);
    expect(screen.getByText(ORGANIZATION.displayName)).toBeInTheDocument();
    expect(screen.getByText(OPERATOR.modelProfile)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /rooms/i }));
    expect(screen.getByText(ROOM.name)).toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /capabilities/i }));
    expect(screen.getByText("repository.read")).toBeInTheDocument();
    expect(screen.getByText("repository.write")).toBeInTheDocument();
  });

  test("keeps a validated saved Agents snapshot visible when the control plane is offline", async () => {
    window.localStorage.setItem("terminus-desktop.agents-directory.v1", JSON.stringify({
      version: 1,
      loadedAt: new Date().toISOString(),
      data: {
        organizations: [ORGANIZATION],
        departments: [DEPARTMENT],
        operators: [OPERATOR],
        rooms: [ROOM],
      },
    }));
    const offline = new TerminusApiError(0, "network error: refused", null);
    vi.spyOn(arpV2, "listOrganizations").mockRejectedValue(offline);
    vi.spyOn(arpV2, "listDepartments").mockRejectedValue(offline);
    vi.spyOn(arpV2, "listOperators").mockRejectedValue(offline);
    vi.spyOn(arpV2, "listAgentRooms").mockRejectedValue(offline);

    render(<AgentsView />);

    expect(screen.getAllByText(OPERATOR.displayName).length).toBeGreaterThan(0);
    expect(await screen.findByText("Offline. Showing saved agent data.")).toBeInTheDocument();
    expect(screen.queryByText("Feynman")).not.toBeInTheDocument();
  });

  test("rejects malformed saved Agents data instead of rendering invented topology", async () => {
    window.localStorage.setItem("terminus-desktop.agents-directory.v1", "{");
    const offline = new TerminusApiError(0, "network error: refused", null);
    vi.spyOn(arpV2, "listOrganizations").mockRejectedValue(offline);
    vi.spyOn(arpV2, "listDepartments").mockRejectedValue(offline);
    vi.spyOn(arpV2, "listOperators").mockRejectedValue(offline);
    vi.spyOn(arpV2, "listAgentRooms").mockRejectedValue(offline);

    render(<AgentsView />);

    expect(await screen.findByText("Offline. Agent data will refresh when the local service reconnects.")).toBeInTheDocument();
    expect(screen.getByText("Agents unavailable")).toBeInTheDocument();
    expect(screen.queryByText(OPERATOR.displayName)).not.toBeInTheDocument();
  });

  test("keeps the last confirmed snapshot visibly stale when a same-scope refresh fails", async () => {
    vi.spyOn(arpV2, "listMaterialQuestions")
      .mockResolvedValueOnce([QUESTION])
      .mockRejectedValueOnce(new TerminusApiError(500, "refresh failed", null));
    vi.spyOn(arpV2, "assessTaskAttention").mockResolvedValue(ASSESSMENT);
    vi.spyOn(arpV2, "resolveMaterialQuestion").mockResolvedValue({
      success: true,
      question: { ...QUESTION, status: "ANSWERED", selectedOption: "Hold", resolvedAt: "2026-08-23T12:01:00.000Z" },
      error: null,
    });

    const user = userEvent.setup();
    render(<AttentionCenterModal isOpen onClose={() => {}} selectedTaskId="task-1" />);
    expect(await screen.findByText(QUESTION.questionText)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `Choose Hold for ${QUESTION.questionText}` }));

    expect(await screen.findByText(/Showing the last successful snapshot/)).toBeInTheDocument();
    expect(screen.queryByText(QUESTION.questionText)).not.toBeInTheDocument();
    expect(screen.getByText("Nothing needs attention")).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="stale"]')).toBeInTheDocument();
  });

  test("does not carry a previous task snapshot into a newly selected task", async () => {
    vi.spyOn(arpV2, "listMaterialQuestions")
      .mockResolvedValueOnce([QUESTION])
      .mockRejectedValueOnce(new TerminusApiError(500, "new task failed", null));
    vi.spyOn(arpV2, "assessTaskAttention")
      .mockResolvedValueOnce(ASSESSMENT)
      .mockRejectedValueOnce(new TerminusApiError(500, "new task failed", null));

    const view = render(<AttentionCenterModal isOpen onClose={() => {}} selectedTaskId="task-1" />);
    expect(await screen.findByText(QUESTION.questionText)).toBeInTheDocument();
    view.rerender(<AttentionCenterModal isOpen onClose={() => {}} selectedTaskId="task-2" />);

    expect(screen.queryByText(QUESTION.questionText)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading material questions" })).toBeInTheDocument();
    expect(await screen.findByText(/Could not load operator data|Couldn't load this view/)).toBeInTheDocument();
    expect(screen.queryByText(QUESTION.questionText)).not.toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="stale"]')).not.toBeInTheDocument();
  });

  test("preserves the durable task while navigating product destinations", async () => {
    useTerminusStore.setState({ selectedTaskId: "task-durable" });
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(
      <Sidebar
        compact={false}
        activeDestination="chat"
        onNavigate={onNavigate}
        taskActionsEnabled
      />,
    );

    expect(screen.getByRole("button", { name: /Sessions|Board|Kanban/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mission Ledger" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Sessions|Board|Kanban/ }));
    await user.click(screen.getByRole("button", { name: "Agents" }));

    expect(onNavigate).toHaveBeenNthCalledWith(1, "board");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "agents");
    expect(useTerminusStore.getState().selectedTaskId).toBe("task-durable");
  });

  test("disables task actions and task-scoped data requests without a durable task", () => {
    const listEffects = vi.spyOn(arpV2, "listEffects");
    render(<EffectQueueView selectedTaskId={null} />);
    expect(screen.getByText(/Choose a (durable )?task/)).toBeInTheDocument();
    expect(listEffects).not.toHaveBeenCalled();

    cleanup();
    render(<Sidebar compact activeDestination="chat" taskActionsEnabled={false} />);
    expect(screen.queryByRole("button", { name: "Task activity" })).not.toBeInTheDocument();

    cleanup();
    render(<StructuredInterventionModal isOpen onClose={() => {}} selectedTaskId={null} />);
    expect(screen.getByText(/Choose a (durable )?task/)).toBeInTheDocument();
  });

  test("requires typed destructive confirmation and never applies a proposal silently", async () => {
    const proposal: StructuredInterventionSnapshot = {
      id: "intervention-1",
      taskId: "task-1",
      attemptId: null,
      actorPrincipal: "operator:ezzy",
      verb: "terminate",
      targetEntityId: "task-1",
      payload: {},
      rationale: "The task is operating outside the approved scope.",
      status: "PROPOSED",
      timestamp: "2026-08-23T12:00:00.000Z",
    };
    const propose = vi.spyOn(arpV2, "proposeIntervention").mockResolvedValue(proposal);
    const apply = vi.spyOn(arpV2, "applyIntervention").mockResolvedValue({
      success: true,
      intervention: { ...proposal, status: "APPLIED" },
      appliedChanges: { taskStatus: "CANCELLED" },
      error: null,
    });
    const user = userEvent.setup();
    render(<StructuredInterventionModal isOpen onClose={() => {}} selectedTaskId="task-1" />);

    await user.click(screen.getByRole("combobox", { name: "Verb" }));
    await user.click(screen.getByRole("option", { name: "Terminate" }));
    await user.type(screen.getByLabelText("Rationale"), "The task is operating outside the approved scope.");
    await user.click(screen.getByRole("button", { name: "Review proposal" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Review proposal" })).toHaveFocus());

    const create = screen.getByRole("button", { name: "Create proposal" });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText(/Type the exact target to confirm/), "task-1");
    await user.click(create);

    expect(await screen.findByText("Proposal created")).toBeInTheDocument();
    expect(propose).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        verb: "terminate",
        targetEntityId: "task-1",
      }),
      { idempotencyKey: expect.stringMatching(/^intervention-proposal\.task-1:/) },
    );
    expect(propose.mock.calls[0]?.[0].taskId).not.toBe("task-default");
    expect(apply).not.toHaveBeenCalled();

    expect(screen.queryByRole("button", { name: "Apply intervention" })).not.toBeInTheDocument();
    expect(screen.getByText(/no kernel-backed intervention executor is configured/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());
    expect(window.localStorage.getItem("terminus-desktop.intervention-draft.v1.task-1")).toBeNull();
  });

  test("restores an unresolved intervention draft for an exact idempotent retry", async () => {
    const user = userEvent.setup();
    const first = render(<StructuredInterventionModal isOpen onClose={() => {}} selectedTaskId="task-1" />);

    await user.type(screen.getByLabelText("Focus target"), "src/kernel.rs");
    await user.type(screen.getByLabelText("Rationale"), "Inspect the exact effect boundary.");
    first.unmount();

    render(<StructuredInterventionModal isOpen onClose={() => {}} selectedTaskId="task-1" />);
    expect(screen.getByLabelText("Focus target")).toHaveValue("src/kernel.rs");
    expect(screen.getByLabelText("Rationale")).toHaveValue("Inspect the exact effect boundary.");
  });

  test("keeps intervention drafts isolated when the selected task changes in place", async () => {
    const user = userEvent.setup();
    const view = render(<StructuredInterventionModal isOpen onClose={() => {}} selectedTaskId="task-1" />);
    await user.type(screen.getByLabelText("Focus target"), "src/task-one.rs");
    await user.type(screen.getByLabelText("Rationale"), "Only task one should retain this rationale.");

    view.rerender(<StructuredInterventionModal isOpen onClose={() => {}} selectedTaskId="task-2" />);
    await waitFor(() => expect(screen.getByLabelText("Focus target")).toHaveValue(""));
    expect(screen.getByLabelText("Rationale")).toHaveValue("");
    await user.type(screen.getByLabelText("Focus target"), "src/task-two.rs");

    view.rerender(<StructuredInterventionModal isOpen onClose={() => {}} selectedTaskId="task-1" />);
    await waitFor(() => expect(screen.getByLabelText("Focus target")).toHaveValue("src/task-one.rs"));
    expect(screen.getByLabelText("Rationale")).toHaveValue("Only task one should retain this rationale.");
    expect(window.localStorage.getItem("terminus-desktop.intervention-draft.v1.task-2")).toContain("src/task-two.rs");
  });

  test("preserves corrupt intervention storage and exposes session-only recovery state", async () => {
    window.localStorage.setItem("terminus-desktop.intervention-draft.v1.task-corrupt", "{");
    const user = userEvent.setup();
    render(<StructuredInterventionModal isOpen onClose={() => {}} selectedTaskId="task-corrupt" />);

    expect(screen.getByRole("status")).toHaveTextContent("could not be read");
    await user.type(screen.getByLabelText("Rationale"), "Keep this only in the current window.");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(window.localStorage.getItem("terminus-desktop.intervention-draft.v1.task-corrupt")).toBe("{");
  });

  test("allows a corrected intervention proposal after a definitive rejection", async () => {
    const proposal: StructuredInterventionSnapshot = {
      id: "intervention-corrected",
      taskId: "task-1",
      attemptId: null,
      actorPrincipal: "operator:ezzy",
      verb: "terminate",
      targetEntityId: "task-1",
      payload: {},
      rationale: "Corrected rationale is specific enough to authorize review.",
      status: "PROPOSED",
      timestamp: "2026-08-23T12:00:00.000Z",
    };
    const propose = vi.spyOn(arpV2, "proposeIntervention")
      .mockRejectedValueOnce(new TerminusApiError(400, "rationale rejected", null))
      .mockResolvedValueOnce(proposal);
    const user = userEvent.setup();
    render(<StructuredInterventionModal isOpen onClose={() => {}} selectedTaskId="task-1" />);

    await user.click(screen.getByRole("combobox", { name: "Verb" }));
    await user.click(screen.getByRole("option", { name: "Terminate" }));
    await user.type(screen.getByLabelText("Rationale"), "First rationale is long enough but rejected.");
    await user.click(screen.getByRole("button", { name: "Review proposal" }));
    await user.type(screen.getByLabelText(/Type the exact target to confirm/), "task-1");
    await user.click(screen.getByRole("button", { name: "Create proposal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("rationale rejected");

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.clear(screen.getByLabelText("Rationale"));
    await user.type(screen.getByLabelText("Rationale"), proposal.rationale);
    await user.click(screen.getByRole("button", { name: "Review proposal" }));
    await user.type(screen.getByLabelText(/Type the exact target to confirm/), "task-1");
    await user.click(screen.getByRole("button", { name: "Create proposal" }));

    expect(await screen.findByText("Proposal created")).toBeInTheDocument();
    expect(propose).toHaveBeenCalledTimes(2);
  });

  test("cockpit dialogs trap focus, close on Escape, and restore their trigger", async () => {
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([]);
    const user = userEvent.setup();
    render(<AttentionHarness />);

    const trigger = screen.getByRole("button", { name: "Open attention center" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Attention center" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(screen.getByRole("button", { name: "Close attention center" })).toHaveFocus());

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Attention center" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  test("keeps Command-A available to native Select All while exposing cockpit actions", async () => {
    const refreshAll = vi.fn(async () => {});
    useTerminusStore.setState({ refreshAll });
    window.localStorage.setItem("terminus-desktop.onboarding.completed.v1", "true");
    render(<App />);
    await waitFor(() => expect(refreshAll).toHaveBeenCalled());

    const commandA = new KeyboardEvent("keydown", {
      key: "a",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(commandA);
    expect(commandA.defaultPrevented).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Attention center" })).not.toBeInTheDocument();

    const commands = buildDefaultCommands({
      openAttentionCenter: vi.fn(),
      openInterventions: vi.fn(),
    });
    expect(commands.find((command) => command.id === "cockpit.attention-center")?.hint).toBeUndefined();
    expect(commands.find((command) => command.id === "cockpit.interventions")?.hint).toBeUndefined();
    expect(commands.filter((command) => command.group === "Cockpit")).toHaveLength(2);
  });

  test("opens the project dialog without treating the sidebar click as a path", async () => {
    const refreshAll = vi.fn(async () => {});
    useTerminusStore.setState({ refreshAll });
    window.localStorage.setItem("terminus-desktop.onboarding.completed.v1", "true");
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(refreshAll).toHaveBeenCalled());

    const openProjectButton = screen.getAllByRole("button", { name: "Open project" }).at(0);
    if (openProjectButton === undefined) throw new Error("Open project button is missing");
    await user.click(openProjectButton);

    expect(await screen.findByRole("dialog", { name: "Open project" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Project path" })).toHaveValue("");
  });

  test("hides task-scoped commands until a task is selected", async () => {
    const refreshAll = vi.fn(async () => {});
    useTerminusStore.setState({ refreshAll });
    window.localStorage.setItem("terminus-desktop.onboarding.completed.v1", "true");
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(refreshAll).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Search tasks and commands" }));

    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByText("Open mission board")).toBeInTheDocument();
    expect(screen.queryByText("Task overview")).not.toBeInTheDocument();
    expect(screen.queryByText("Task changes")).not.toBeInTheDocument();
    expect(screen.queryByText("Toggle inspector")).not.toBeInTheDocument();
  });

  test("keeps a Board-only canonical task selected across every task workspace command", async () => {
    const refreshAll = vi.fn(async () => {});
    useTerminusStore.setState({ refreshAll });
    window.localStorage.setItem("terminus-desktop.onboarding.completed.v1", "true");
    // R12: governance tabs (Overview/Activity/Replay/Usage/Evidence) are now
    // opt-in; this routing test exercises them explicitly.
    window.localStorage.setItem("terminus-desktop.governance-views.enabled", "true");
    vi.spyOn(arpV2, "listTasks").mockResolvedValue([CANONICAL_TASK]);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue({
      readyState: 1,
      lastEventId: null,
      addEventListener: () => () => {},
      close: vi.fn(),
    });
    const getTask = vi.spyOn(arpV2, "getTask").mockRejectedValue(new Error("task fixture stops after routing"));
    const listEffects = vi.spyOn(arpV2, "listEffects").mockRejectedValue(new Error("effect fixture stops after routing"));
    const listArtifacts = vi.spyOn(api, "listTaskArtifacts").mockRejectedValue(new Error("artifact fixture stops after routing"));
    const getBudget = vi.spyOn(arpV2, "getTaskBudget").mockRejectedValue(new Error("budget fixture stops after routing"));
    const getCausalTrace = vi.spyOn(arpV2, "getCausalTrace").mockRejectedValue(new Error("replay fixture stops after routing"));
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(refreshAll).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: /Sessions|Board|Kanban/ }));
    await screen.findByRole("heading", { name: /Sessions|Board|Kanban/ });
    await user.click(await screen.findByRole("button", { name: "Actions for Polish the desktop UI" }));
    await user.click(screen.getByRole("menuitem", { name: /Task details|View details/ }));
    await screen.findByRole("tab", { name: "Overview" });

    const cases = [
      { command: "Task overview", tab: "Overview", verify: () => expect(getTask).toHaveBeenCalledWith(CANONICAL_TASK.id, expect.any(AbortSignal)) },
      { command: "Task activity", tab: "Activity", verify: () => expect(listEffects).toHaveBeenCalledWith(CANONICAL_TASK.id, expect.any(AbortSignal)) },
      { command: "Task changes", tab: "Changes", verify: () => expect(listArtifacts).toHaveBeenCalledWith(CANONICAL_TASK.id, null, expect.any(AbortSignal)) },
      { command: "Task usage", tab: "Usage", verify: () => expect(getBudget).toHaveBeenCalledWith(CANONICAL_TASK.id, expect.any(AbortSignal)) },
      { command: "Task replay", tab: "Replay", verify: () => expect(getCausalTrace).toHaveBeenCalledWith(CANONICAL_TASK.id, expect.any(AbortSignal)) },
    ] as const;

    for (const commandCase of cases) {
      await user.click(screen.getByRole("button", { name: "Search tasks and commands" }));
      await user.click(await screen.findByText(commandCase.command));
      await waitFor(() => expect(screen.getByRole("tab", { name: commandCase.tab })).toHaveAttribute("aria-selected", "true"));
      expect(screen.queryByText("Choose a durable task")).not.toBeInTheDocument();
      await waitFor(commandCase.verify);
    }
  });

  test("exposes the combined Agents workspace as one navigation command", () => {
    const openAgents = vi.fn();
    const commands = buildDefaultCommands({ openAgents });

    expect(commands.filter((command) => command.id === "nav.agents")).toHaveLength(1);
    expect(commands.some((command) => command.id === "cockpit.org-map")).toBe(false);
    expect(commands.some((command) => command.id === "cockpit.agent-rooms")).toBe(false);
    commands.find((command) => command.id === "nav.agents")?.action();
    expect(openAgents).toHaveBeenCalledTimes(1);
  });

  test("keeps task evidence inside Overview instead of exposing a duplicate command", () => {
    const commands = buildDefaultCommands({ openMissionLedger: vi.fn() });

    expect(commands.filter((command) => command.id === "cockpit.mission-ledger")).toHaveLength(1);
    expect(commands.some((command) => command.id === "cockpit.claim-evidence")).toBe(false);
  });

  test("states unsupported task capabilities as unavailable instead of rendering demo nodes", () => {
    render(<WorkflowGraphView selectedTaskId="task-1" />);
    expect(screen.getByText(/Task workflow graph.*unavailable/)).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="unavailable"]')).toBeInTheDocument();
    expect(screen.queryByText("Parse Context & Directives")).not.toBeInTheDocument();
  });

  test("renders a missing causal trace as empty instead of an error or fabricated timeline", async () => {
    vi.spyOn(arpV2, "getCausalTrace").mockResolvedValue(null);
    render(<CausalReplayView selectedTaskId="task-1" />);

    expect(await screen.findByText("No causal trace")).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="empty"]')).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="error"]')).not.toBeInTheDocument();
  });

  test("keeps a confirmed null causal trace visible when its refresh becomes stale", async () => {
    vi.spyOn(arpV2, "getCausalTrace")
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new TerminusApiError(500, "trace refresh failed", null));
    const user = userEvent.setup();
    render(<CausalReplayView selectedTaskId="task-1" />);

    expect(await screen.findByText("No causal trace")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh snapshot" }));

    expect(await screen.findByText(/Showing the last successful snapshot/)).toBeInTheDocument();
    expect(screen.getByText("No causal trace")).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="stale"]')).toBeInTheDocument();
  });

  test("allows a changed counterfactual after a definitive rejection", async () => {
    vi.spyOn(arpV2, "getCausalTrace").mockResolvedValue(CAUSAL_TRACE);
    const run = vi.spyOn(arpV2, "runCounterfactual")
      .mockRejectedValueOnce(new TerminusApiError(400, "variation rejected", null))
      .mockResolvedValueOnce(COUNTERFACTUAL);
    const user = userEvent.setup();
    render(<CausalReplayView selectedTaskId="task-1" />);

    const detail = await screen.findByLabelText("Variation detail");
    await user.type(detail, "profile-a");
    await user.click(screen.getByRole("button", { name: "Evaluate experiment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("variation rejected");

    await user.clear(detail);
    await user.type(detail, "profile-b");
    await user.click(screen.getByRole("button", { name: "Evaluate experiment" }));

    expect(await screen.findByText(/Counterfactual hypothesis/)).toBeInTheDocument();
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("renders only server-reported room data", async () => {
    vi.spyOn(arpV2, "listAgentRooms").mockResolvedValue([ROOM]);
    render(<DepartmentRoomsView />);
    expect(await screen.findByText(ROOM.name)).toBeInTheDocument();
    expect(screen.getByText("worker-1")).toBeInTheDocument();
    expect(screen.queryByText("Agent progressing normally")).not.toBeInTheDocument();
  });
});
