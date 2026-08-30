import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "../src/App";
import { AgentsView } from "../src/components/AgentsView";
import { CockpitEmptyState, CockpitErrorState } from "../src/components/Cockpit/CockpitPrimitives";
import { MaterialQuestionCard } from "../src/components/MaterialQuestionCard";
import { StructuredInterventionModal } from "../src/components/Cockpit/StructuredInterventionModal";
import { buildDefaultCommands } from "../src/lib/command-catalog";
import { FIXED_SHORTCUTS, shortcutDisplay } from "../src/lib/shortcuts";
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

/** A second pending question on the same task, for the stale-refresh case. */
const FOLLOW_UP_QUESTION: MaterialQuestionSnapshot = {
  ...QUESTION,
  id: "question-2",
  questionText: "Tag the release as latest?",
  consequenceMatrix: { Tag: "Downstream installs move.", Skip: "Nothing moves." },
  options: ["Tag", "Skip"],
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

/**
 * The attention center was a modal; answering a material question is now an
 * inline section of the inspector. What is left to check here is that the
 * dialogs that genuinely remain dialogs still behave like ones.
 */
function InterventionHarness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open structured intervention</button>
      {open ? <StructuredInterventionModal isOpen onClose={() => setOpen(false)} selectedTaskId="task-1" /> : null}
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

  test("renders API errors, unavailability, and empty collections as distinct states", () => {
    // These are the three resource states shared by every data-backed view, so
    // they are asserted on the primitive rather than through whichever view
    // happens to consume it today.
    const retry = vi.fn();

    const errorRender = render(
      <CockpitErrorState error={new TerminusApiError(500, "directory failed", null)} retry={retry} />,
    );
    expect(screen.getByText("Couldn't load this view")).toBeInTheDocument();
    expect(screen.getByText("directory failed")).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="error"]')).toBeInTheDocument();
    errorRender.unmount();

    const offlineRender = render(
      <CockpitErrorState error={new TerminusApiError(0, "network error: refused", null)} retry={retry} />,
    );
    expect(screen.getByText("Terminus is offline")).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="unavailable"]')).toBeInTheDocument();
    offlineRender.unmount();

    // A control plane that does not implement the route is unavailable, not broken.
    const unimplementedRender = render(
      <CockpitErrorState error={new TerminusApiError(501, "not implemented", null)} retry={retry} />,
    );
    expect(screen.getByText("This view is unavailable")).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="unavailable"]')).toBeInTheDocument();
    unimplementedRender.unmount();

    render(<CockpitEmptyState title="No agent rooms" description="Nothing has been registered yet." />);
    expect(screen.getByText("No agent rooms")).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="empty"]')).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="error"]')).not.toBeInTheDocument();
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
      .mockResolvedValueOnce([QUESTION, FOLLOW_UP_QUESTION])
      .mockRejectedValueOnce(new TerminusApiError(500, "refresh failed", null));
    vi.spyOn(arpV2, "resolveMaterialQuestion").mockResolvedValue({
      success: true,
      question: { ...QUESTION, status: "ANSWERED", selectedOption: "Hold", resolvedAt: "2026-08-23T12:01:00.000Z" },
      error: null,
    });

    const user = userEvent.setup();
    render(<MaterialQuestionCard taskId="task-1" />);
    expect(await screen.findByText(QUESTION.questionText)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `Choose Hold for ${QUESTION.questionText}` }));

    // The answered one is gone and the next one is up — but the refresh that
    // should have confirmed both failed, so the card says the question it is
    // showing may already have been decided elsewhere.
    expect(await screen.findByText(FOLLOW_UP_QUESTION.questionText)).toBeInTheDocument();
    expect(screen.queryByText(QUESTION.questionText)).not.toBeInTheDocument();
    expect(screen.getByText(/Showing the last successful snapshot/)).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="stale"]')).toBeInTheDocument();
  });

  test("does not carry a previous task snapshot into a newly selected task", async () => {
    vi.spyOn(arpV2, "listMaterialQuestions")
      .mockResolvedValueOnce([QUESTION])
      .mockRejectedValueOnce(new TerminusApiError(500, "new task failed", null));

    const view = render(<MaterialQuestionCard taskId="task-1" />);
    expect(await screen.findByText(QUESTION.questionText)).toBeInTheDocument();
    view.rerender(<MaterialQuestionCard taskId="task-2" />);

    // task-1's question must not be attributed to task-2 for even one frame,
    // and a task whose questions could not be loaded is silent rather than
    // borrowing the previous one.
    expect(screen.queryByText(QUESTION.questionText)).not.toBeInTheDocument();
    await waitFor(() => expect(arpV2.listMaterialQuestions).toHaveBeenCalledWith("task-2", expect.anything()));
    expect(screen.queryByText(QUESTION.questionText)).not.toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="stale"]')).not.toBeInTheDocument();
  });

  test("preserves the durable task while navigating product destinations", async () => {
    useTerminusStore.setState({ selectedTaskId: "task-durable" });
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(
      <Sidebar
        activeDestination="chat"
        onNavigate={onNavigate}
      />,
    );

    expect(screen.getByRole("button", { name: /Sessions|Board|Kanban/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mission Ledger" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agents" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Sessions|Board|Kanban/ }));

    expect(onNavigate).toHaveBeenNthCalledWith(1, "board");
    expect(useTerminusStore.getState().selectedTaskId).toBe("task-durable");
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
    const user = userEvent.setup();
    render(<InterventionHarness />);

    const trigger = screen.getByRole("button", { name: "Open structured intervention" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Structured intervention" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Structured intervention" })).not.toBeInTheDocument();
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

    // The queue command has a key now, and it is deliberately not ⌘A: Select
    // All belongs to the platform, and the palette must not advertise a
    // binding that never fires.
    const commands = buildDefaultCommands({ focusQueue: vi.fn() });
    expect(commands.find((command) => command.id === "task.attention")?.hint)
      .toBe(shortcutDisplay(FIXED_SHORTCUTS.focusQueue));
    // "Steer this task" had no action behind it in the app; it is gone rather
    // than listed and silently dropped.
    expect(commands.some((command) => command.id === "task.intervene")).toBe(false);
  });

  test("opens the project dialog without treating the sidebar click as a path", async () => {
    const refreshAll = vi.fn(async () => {});
    useTerminusStore.setState({ refreshAll });
    window.localStorage.setItem("terminus-desktop.onboarding.completed.v1", "true");
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(refreshAll).toHaveBeenCalled());

    // Exactly one, deliberately: the sidebar used to offer "Open project"
    // three times at once — the Spaces header, the empty state, and a docked
    // nav row.
    await user.click(screen.getByRole("button", { name: "Show projects" }));
    await user.click(screen.getByRole("button", { name: "Open project" }));

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

    // The palette is reached from the task search's quick actions rather
    // than from a second magnifying glass beside the first.
    await user.click(screen.getByRole("button", { name: "Search tasks" }));
    await user.click(await screen.findByRole("option", { name: /Commands/ }));

    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByText("Open board")).toBeInTheDocument();
    expect(screen.queryByText("Task overview")).not.toBeInTheDocument();
    expect(screen.queryByText("Task changes")).not.toBeInTheDocument();
    expect(screen.queryByText("Toggle inspector")).not.toBeInTheDocument();
  });

  test("keeps a Board-only canonical task selected across the task workspace tabs", async () => {
    const refreshAll = vi.fn(async () => {});
    useTerminusStore.setState({ refreshAll });
    window.localStorage.setItem("terminus-desktop.onboarding.completed.v1", "true");
    vi.spyOn(arpV2, "listTasks").mockResolvedValue([CANONICAL_TASK]);
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([]);
    vi.spyOn(apiV2Module, "subscribeEventsV2").mockReturnValue({
      readyState: 1,
      lastEventId: null,
      addEventListener: () => () => {},
      close: vi.fn(),
    });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(refreshAll).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: /Sessions|Board|Kanban/ }));
    await screen.findByRole("heading", { name: /Sessions|Board|Kanban/ });
    await user.click(await screen.findByRole("button", { name: "Actions for Polish the desktop UI" }));
    await user.click(screen.getByRole("menuitem", { name: /Task details|View details/ }));

    // Two tabs, session first. The retired governance tabs must not come back.
    const sessionTab = await screen.findByRole("tab", { name: "Session" });
    expect(sessionTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Changes" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    for (const retired of ["Overview", "Activity", "Replay", "Usage", "Evidence"]) {
      expect(screen.queryByRole("tab", { name: retired })).not.toBeInTheDocument();
    }

    // Switching tabs must not drop the canonical task that the Board selected.
    await user.click(screen.getByRole("tab", { name: "Changes" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true"));

    // A board-only canonical task has no durable event stream yet, so Changes
    // states that plainly instead of rendering an empty pane.
    expect(await screen.findByText("Choose a task")).toBeInTheDocument();
    expect(document.querySelector('[data-cockpit-state="task-required"]')).toBeInTheDocument();
  });

  // The Agents workspace is built from a directory of departments, operators
  // and rooms that no control-plane route serves. Advertising a destination
  // that can only show invented structure is worse than not offering it.
  test("offers no Agents destination while the surface has no data behind it", () => {
    const commands = buildDefaultCommands({ openMissionBoard: vi.fn() });

    expect(commands.some((command) => command.id === "nav.agents")).toBe(false);
    expect(commands.some((command) => command.id === "cockpit.org-map")).toBe(false);
    expect(commands.some((command) => command.id === "cockpit.agent-rooms")).toBe(false);
  });

  test("exposes no governance-view commands after the cockpit tabs were removed", () => {
    const commands = buildDefaultCommands({ focusQueue: vi.fn() });

    for (const retired of [
      "cockpit.mission-ledger",
      "cockpit.effect-queue",
      "cockpit.artifact-diff",
      "cockpit.fleet-budget",
      "cockpit.causal-replay",
      "cockpit.claim-evidence",
    ]) {
      expect(commands.some((command) => command.id === retired)).toBe(false);
    }
    expect(commands.some((command) => command.group === ("Cockpit" as never))).toBe(false);
  });

});
