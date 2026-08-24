/**
 * Terminus Desktop — Dev Mock Harness.
 *
 * Populates realistic spaces, sessions, and fleet tasks for visual design audit
 * when loaded with `?mock=true`.
 */
import { useTerminusStore } from "../hooks/use-terminus";
import { arpV2 } from "./api-v2";
import type { ClaimSnapshot, EvidenceSnapshot, MaterialQuestionSnapshot, TaskV2Snapshot } from "../types/v2";
import type { Task, TaskDomainStatus } from "../types";

export function setupDevMock(): void {
  try {
    window.localStorage.setItem("terminus-desktop.onboarding.completed.v1", "true");
  } catch {}

  // Stands in for the provider inventory the control plane will serve. It
  // lives here, behind `?mock=true`, precisely so no fabricated model list can
  // reach a real install: without a provider reporting models the composer
  // shows no picker at all.
  window.__terminusModelInventory = {
    providers: [
      { id: "open_code_zen", label: "OpenCode Zen", mark: "OC" },
      { id: "codex", label: "Codex", mark: "CX", available: false, unavailable_reason: "Connect a Codex adapter in Settings to route turns here." },
    ],
    models: [
      { id: "nemotron-3-lightning", provider: "open_code_zen", label: "Nemotron 3 Lightning", slug: "nemotron-3-lightning", free: true, reasoning: false, context_tokens: 131_072, tool_calling: true },
      { id: "ox-alpha", provider: "open_code_zen", label: "Ox Alpha", slug: "ox-alpha", free: true, reasoning: true, context_tokens: 256_000, tool_calling: true },
      { id: "grok-code", provider: "open_code_zen", label: "Grok Code", slug: "grok-code", reasoning: true, context_tokens: 1_000_000, tool_calling: true },
      { id: "gpt-5.6-sol", provider: "codex", label: "GPT-5.6-Sol", slug: "gpt-5.6-sol", reasoning: true, context_tokens: 400_000, tool_calling: true },
    ],
  };

  const sessions = [
    {
      id: "session-1",
      workspace_id: "ws-1",
      title: "Terminus Control Plane",
      status: "active" as const,
      default_permission_profile: "secure-local-default",
      active_thread_id: "thread-1",
      created_at: new Date(Date.now() - 3600000 * 24).toISOString(),
      updated_at: new Date(Date.now() - 60000 * 5).toISOString(),
    },
    {
      id: "session-2",
      workspace_id: "ws-1",
      title: "Learning rate tuning",
      status: "active" as const,
      default_permission_profile: "secure-local-default",
      active_thread_id: "thread-2",
      created_at: new Date(Date.now() - 3600000 * 48).toISOString(),
      updated_at: new Date(Date.now() - 60000 * 25).toISOString(),
    },
    {
      id: "session-3",
      workspace_id: "ws-2",
      title: "Neural Engine Core",
      status: "active" as const,
      default_permission_profile: "secure-local-default",
      active_thread_id: "thread-3",
      created_at: new Date(Date.now() - 3600000 * 72).toISOString(),
      updated_at: new Date(Date.now() - 3600000 * 3).toISOString(),
    },
  ];

  const tasks: TaskV2Snapshot[] = [
    {
      id: "task-101",
      missionId: "mission-1",
      organizationId: "org-1",
      departmentId: "dept-1",
      createdBy: "operator:ezzy",
      conversationContext: { sessionId: "session-1", threadId: "thread-1", attachedAt: new Date().toISOString() },
      contract: {
        version: 1,
        mission: "Refactor Rust effect kernel RPC and UDS socket handler",
        mode: "autonomous",
        authorityCeiling: ["kernel.fs.write", "kernel.proc.exec"],
        scope: { resources: [], allowedEffectClasses: ["fs", "proc"], excludedPathsOrSystems: [] },
        acceptance: [
          { claimId: "c1", statement: "Non-bypassable effect check passing", evidenceRequirement: "Unit tests" },
        ],
        constraints: { security: [], costMicros: "10000000", timeoutSeconds: 3600 },
      },
      status: "RUNNING",
      version: 3,
      createdAt: new Date(Date.now() - 1800000).toISOString(),
      updatedAt: new Date(Date.now() - 60000 * 2).toISOString(),
      completedAt: null,
    },
    {
      id: "task-102",
      missionId: "mission-1",
      organizationId: "org-1",
      departmentId: "dept-1",
      createdBy: "operator:ezzy",
      conversationContext: { sessionId: "session-1", threadId: "thread-1", attachedAt: new Date().toISOString() },
      contract: {
        version: 1,
        mission: "Implement 2-line session cards in Sidebar with activity pulse",
        mode: "autonomous",
        authorityCeiling: ["desktop.ui.write"],
        scope: { resources: [], allowedEffectClasses: ["fs"], excludedPathsOrSystems: [] },
        acceptance: [],
        constraints: { security: [], costMicros: "5000000", timeoutSeconds: 1800 },
      },
      status: "RUNNING",
      version: 2,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      updatedAt: new Date(Date.now() - 60000 * 10).toISOString(),
      completedAt: null,
    },
    {
      id: "task-103",
      missionId: "mission-2",
      organizationId: "org-1",
      departmentId: "dept-1",
      createdBy: "operator:ezzy",
      conversationContext: { sessionId: "session-2", threadId: "thread-2", attachedAt: new Date().toISOString() },
      contract: {
        version: 1,
        mission: "Hyperparameter sweep across batch sizes 32, 64, 128",
        mode: "autonomous",
        authorityCeiling: ["proc.spawn"],
        scope: { resources: [], allowedEffectClasses: ["proc"], excludedPathsOrSystems: [] },
        acceptance: [],
        constraints: { security: [], costMicros: "25000000", timeoutSeconds: 7200 },
      },
      status: "WAITING_USER",
      version: 4,
      createdAt: new Date(Date.now() - 7200000).toISOString(),
      updatedAt: new Date(Date.now() - 60000 * 15).toISOString(),
      completedAt: null,
    },
    {
      id: "task-104",
      missionId: "mission-1",
      organizationId: "org-1",
      departmentId: "dept-1",
      createdBy: "operator:ezzy",
      conversationContext: { sessionId: "session-1", threadId: "thread-1", attachedAt: new Date().toISOString() },
      contract: {
        version: 1,
        mission: "Build multi-facet filter bar and macOS toolbar controls",
        mode: "autonomous",
        authorityCeiling: ["desktop.ui.write"],
        scope: { resources: [], allowedEffectClasses: ["fs"], excludedPathsOrSystems: [] },
        acceptance: [],
        constraints: { security: [], costMicros: "5000000", timeoutSeconds: 1800 },
      },
      status: "VERIFYING",
      version: 5,
      createdAt: new Date(Date.now() - 14400000).toISOString(),
      updatedAt: new Date(Date.now() - 60000 * 30).toISOString(),
      completedAt: null,
    },
    {
      id: "task-105",
      missionId: "mission-3",
      organizationId: "org-1",
      departmentId: "dept-1",
      createdBy: "operator:ezzy",
      conversationContext: { sessionId: "session-3", threadId: "thread-3", attachedAt: new Date().toISOString() },
      contract: {
        version: 1,
        mission: "Optimize attention matrix multiply kernel for Apple Silicon M4",
        mode: "autonomous",
        authorityCeiling: ["kernel.metal.exec"],
        scope: { resources: [], allowedEffectClasses: ["metal"], excludedPathsOrSystems: [] },
        acceptance: [],
        constraints: { security: [], costMicros: "50000000", timeoutSeconds: 7200 },
      },
      status: "COMPLETED",
      version: 8,
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 3600000 * 4).toISOString(),
      completedAt: new Date(Date.now() - 3600000 * 4).toISOString(),
    },
    {
      id: "task-106",
      missionId: "mission-3",
      organizationId: "org-1",
      departmentId: "dept-1",
      createdBy: "operator:ezzy",
      conversationContext: { sessionId: "session-3", threadId: "thread-3", attachedAt: new Date().toISOString() },
      contract: {
        version: 1,
        mission: "Add KV cache compression with int8 quantization",
        mode: "autonomous",
        authorityCeiling: ["kernel.metal.exec"],
        scope: { resources: [], allowedEffectClasses: ["metal"], excludedPathsOrSystems: [] },
        acceptance: [],
        constraints: { security: [], costMicros: "30000000", timeoutSeconds: 3600 },
      },
      status: "COMPLETED",
      version: 6,
      createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
      updatedAt: new Date(Date.now() - 3600000 * 18).toISOString(),
      completedAt: new Date(Date.now() - 3600000 * 18).toISOString(),
    },
  ];

  const questions: MaterialQuestionSnapshot[] = [
    {
      id: "q-1",
      taskId: "task-103",
      trigger: "interpretation_divergence",
      questionText: "Which learning rate decay schedule should be used for the 128-batch run: cosine or linear?",
      consequenceMatrix: {
        cosine: "Smoother tail, ~40 min longer per sweep.",
        linear: "Finishes inside the CI budget, slightly worse final loss.",
      },
      options: ["cosine", "linear"],
      status: "PENDING",
      suggestedOption: "cosine",
      selectedOption: null,
      createdAt: new Date(Date.now() - 60000 * 15).toISOString(),
      resolvedAt: null,
    },
  ];

  const claims: ClaimSnapshot[] = tasks.flatMap((task) => task.contract.acceptance.map((criterion) => ({
    id: criterion.claimId,
    taskId: task.id,
    statement: criterion.statement,
    requiredEvidenceKind: criterion.evidenceRequirement,
    // Offline fixtures must never look like trusted proof. The mock has no
    // immutable artifact or verifier, so leave its claims and receipts
    // explicitly unadmitted.
    status: "PROPOSED",
    evidenceIds: [`evidence-${criterion.claimId}`],
    waivedRationale: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  })));
  // There is no immutable artifact or verifier in mock mode. Return no
  // receipts so the cockpit cannot present fixture data as admitted proof.
  const evidence: EvidenceSnapshot[] = [];

  const SESSION_BY_TASK: Record<string, string> = {
    "task-101": "session-1",
    "task-102": "session-1",
    "task-103": "session-2",
    "task-105": "session-3",
  };
  const THREAD_BY_TASK: Record<string, string> = {
    "task-101": "thread-1",
    "task-102": "thread-1",
    "task-103": "thread-2",
    "task-105": "thread-3",
  };

  // Intercept arpV2 calls for mock mode
  arpV2.listTasks = async () => tasks;
  arpV2.listMaterialQuestions = async () => questions;
  arpV2.getTask = async (id) => tasks.find((t) => t.id === id) ?? null;
  arpV2.listClaims = async (taskId) => claims.filter((claim) => claim.taskId === taskId);
  arpV2.listEvidence = async (taskId) => {
    const claimIds = new Set(claims.filter((claim) => claim.taskId === taskId).map((claim) => claim.id));
    return evidence.filter((item) => claimIds.has(item.claimId));
  };

  const V1_STATUS_BY_TASK: Record<string, TaskDomainStatus> = {
    "task-101": "ACTIVE",
    "task-102": "ACTIVE",
    "task-103": "NEEDS_USER_DECISION",
    "task-105": "COMPLETED",
  };

  const taskById: Record<string, Task> = Object.fromEntries(
    tasks
      .filter((task) => task.id in V1_STATUS_BY_TASK)
      .map((task): [string, Task] => {
        const status = V1_STATUS_BY_TASK[task.id] ?? "ACTIVE";
        return [task.id, {
          id: task.id,
          session_id: SESSION_BY_TASK[task.id] ?? "session-1",
          thread_id: THREAD_BY_TASK[task.id] ?? "thread-1",
          status,
          phase: status === "COMPLETED" ? "settled" : "executing",
          active_contract_version: 1,
          risk_class: "normal",
          created_at: task.createdAt,
          updated_at: task.updatedAt,
          completed_at: status === "COMPLETED" ? task.completedAt ?? null : null,
          terminal_reason: null,
          contract: {
            version: 1,
            objective: task.contract.mission,
            non_goals: [],
            allowed_scope: { read_paths: ["."], write_paths: ["."], external_systems: [] },
          },
        }];
      }),
  );

  useTerminusStore.setState({
    sessions,
    healthReady: true,
    healthStatus: "ready",
    streamState: "connected",
    selectedSessionId: "session-1",
    taskById,
    tasksBySession: {
      "session-1": Object.values(taskById).filter((task) => task.session_id === "session-1"),
      "session-2": Object.values(taskById).filter((task) => task.session_id === "session-2"),
      "session-3": Object.values(taskById).filter((task) => task.session_id === "session-3"),
    },
    eventsByTask: {
      "task-101": [
        {
          id: "ev-1",
          event: "turn.started",
          data: JSON.stringify({
            user_input: "Refactor Rust effect kernel RPC and UDS socket handler to ensure non-bypassable security checks.",
            started_at: new Date(Date.now() - 1800000).toISOString(),
          }),
        },
        {
          id: "ev-2",
          event: "tool.settled",
          data: JSON.stringify({
            tool: "read",
            args_summary: "crates/terminus-kernel/src/socket.rs",
            result_status: "success",
            summary: "read 180 lines",
          }),
        },
        {
          id: "ev-3",
          event: "tool.settled",
          data: JSON.stringify({
            tool: "patch",
            args_summary: "crates/terminus-kernel/src/socket.rs",
            result_status: "success",
            summary: "updated UDS permission checks",
          }),
        },
        {
          id: "ev-4",
          event: "tool.settled",
          data: JSON.stringify({
            tool: "verify",
            args_summary: "cargo test --package terminus-kernel",
            result_status: "success",
            summary: "12 tests passed",
          }),
        },
        {
          id: "ev-5",
          event: "turn.completed",
          data: JSON.stringify({
            summary: "I have refactored the Rust effect kernel RPC and UDS socket handler. All 12 adversarial security invariant tests are passing without bypass paths.",
          }),
        },
      ],
    },
    // A boundary is only recorded when history was actually truncated; the
    // absence of a key is the "nothing was dropped" state, not null.
    eventHistoryByTask: {},
  });
}
