/**
 * Small, defensive projections from the runtime event stream into desktop
 * surfaces. The control plane remains the source of truth; this module only
 * derives presentation state from its existing event contract.
 */
import type { ApprovalSummary, TerminusSseEvent } from "../types";

export interface PendingApproval {
  id: string;
  action: string;
  risk: "low" | "normal" | "high" | "critical" | "unknown";
  reversibility?: string;
  operationHash?: string;
  operation?: string;
  reason?: string;
  scope?: string[];
  environment?: string;
  requestedAt?: string;
  expiresAt?: string;
  canPersist: boolean;
  supportedDecisions: ApprovalSummary["supported_decisions"];
  authorizationReady: boolean;
}

export interface SubagentActivity {
  id: string;
  role: string;
  state: "working" | "done" | "failed";
  worktreeId?: string;
}

export interface VerificationActivity {
  id: string;
  state: "passed" | "failed" | "running";
  detail: string;
}

export interface ComputerUseActivity {
  active: boolean;
  paused: boolean;
}

function eventPayload(event: TerminusSseEvent): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(event.data);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringField(value: Record<string, unknown>, ...fields: string[]): string | undefined {
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function stringArrayField(value: Record<string, unknown>, ...fields: string[]): string[] | undefined {
  for (const field of fields) {
    const candidate = value[field];
    if (Array.isArray(candidate)) {
      const strings = candidate.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
      if (strings.length > 0) return strings;
    }
  }
  return undefined;
}

function approvalRisk(value: string | undefined): PendingApproval["risk"] {
  return value === "low" || value === "normal" || value === "high" || value === "critical"
    ? value
    : "unknown";
}

/** Short, stable display label for an operation hash when no plain-language summary exists. */
export function operationLabel(operationHash: string): string {
  const short = operationHash.length > 14 ? `${operationHash.slice(0, 13)}…` : operationHash;
  return `Pending effect ${short}`;
}

/**
 * Project the authoritative approval snapshot into the UI. Allow choices are
 * enabled only when the server supplied one complete, internally consistent
 * operation binding; legacy rows remain denyable but cannot authorize work.
 */
export function pendingApprovalFromServerRow(row: ApprovalSummary): PendingApproval {
  const binding = row.binding;
  const display = row.display;
  const expiryMatches = binding?.expires_at === row.expires_at;
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : null;
  const unexpired = expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > Date.now());
  const risk = approvalRisk(row.risk);
  const authorizationReady = Boolean(
    binding
    && display
    && binding.task_id === row.task_id
    && binding.exact_action === display.exact_action
    && binding.use_limit === row.use_limit
    && expiryMatches
    && unexpired
    && row.scope.length > 0
    && risk !== "unknown",
  );
  return {
    id: row.id,
    action: display?.summary ?? operationLabel(row.operation_hash),
    risk,
    reversibility: display?.reversibility ?? undefined,
    operationHash: row.operation_hash,
    operation: display?.exact_action,
    reason: display?.reason,
    scope: row.scope.length > 0 ? row.scope : undefined,
    environment: display?.environment ?? undefined,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at ?? undefined,
    canPersist: row.use_limit > 1,
    supportedDecisions: row.supported_decisions,
    authorizationReady,
  };
}

/**
 * Merge the server's pending-approval snapshot with richer event-derived
 * entries. A server snapshot anchors identity and operation hash. Event detail
 * may enrich display context only when it binds to that exact hash; it cannot
 * independently enable an allow action or widen persistence.
 */
export function mergePendingApprovals(
  server: PendingApproval[],
  derived: PendingApproval[],
): PendingApproval[] {
  const byId = new Map<string, PendingApproval>();
  for (const entry of server) byId.set(entry.id, entry);
  for (const entry of derived) {
    const current = byId.get(entry.id);
    if (!current) {
      byId.set(entry.id, { ...entry, canPersist: false, authorizationReady: false });
      continue;
    }
    const operationMatches = Boolean(
      current.operationHash
      && entry.operationHash
      && current.operationHash === entry.operationHash,
    );
    if (!operationMatches) continue;
    if (current.authorizationReady) continue;
    const risk = entry.risk === "unknown" ? current.risk : entry.risk;
    const scope = entry.scope ?? current.scope;
    byId.set(entry.id, {
      ...current,
      action: entry.action,
      risk,
      reversibility: entry.reversibility,
      operation: entry.operation,
      reason: entry.reason,
      scope,
      environment: entry.environment,
      requestedAt: entry.requestedAt ?? current.requestedAt,
      canPersist: current.canPersist && entry.canPersist,
      supportedDecisions: current.supportedDecisions,
      authorizationReady: false,
    });
  }
  return [...byId.values()];
}

export function derivePendingApprovals(events: TerminusSseEvent[]): PendingApproval[] {
  const pending = new Map<string, PendingApproval>();
  for (const event of events) {
    const payload = eventPayload(event);
    if (!payload) continue;
    if (event.event === "approval.requested") {
      const id = stringField(payload, "approval_id", "approvalId");
      if (!id) continue;
      const operationHash = stringField(payload, "operation_hash", "operationHash");
      const operation = stringField(payload, "operation", "command", "exact_operation", "exactOperation");
      pending.set(id, {
        id,
        action:
          stringField(payload, "operation_summary", "operationSummary")
          ?? (operationHash ? operationLabel(operationHash) : "Approval details unavailable"),
        risk: approvalRisk(stringField(payload, "risk")),
        reversibility: stringField(payload, "reversibility"),
        operationHash,
        operation,
        reason: stringField(payload, "reason", "rationale", "why_required", "whyRequired"),
        scope: stringArrayField(payload, "scope", "affected_paths", "affectedPaths"),
        environment: stringField(payload, "environment", "affected_environment", "affectedEnvironment"),
        requestedAt: stringField(payload, "requested_at", "requestedAt"),
        expiresAt: stringField(payload, "expires_at", "expiresAt"),
        canPersist:
          typeof payload.use_limit === "number"
            ? payload.use_limit > 1
            : payload.can_persist === true || payload.canPersist === true,
        supportedDecisions: ["deny_once"],
        authorizationReady: false,
      });
    }
    if (event.event === "approval.resolved") {
      const id = stringField(payload, "approval_id", "approvalId");
      if (id) pending.delete(id);
    }
  }
  return [...pending.values()];
}

export function deriveSubagentActivity(events: TerminusSseEvent[]): SubagentActivity[] {
  const agents = new Map<string, SubagentActivity>();
  for (const event of events) {
    const payload = eventPayload(event);
    if (!payload) continue;
    if (event.event === "agent.spawned") {
      const id = stringField(payload, "agent_id", "agentId");
      if (!id) continue;
      agents.set(id, {
        id,
        role: stringField(payload, "role") ?? "Delegated task",
        state: "working",
        worktreeId: stringField(payload, "worktree_id", "worktreeId"),
      });
    }
    if (event.event === "agent.completed") {
      const id = stringField(payload, "agent_id", "agentId");
      const current = id ? agents.get(id) : undefined;
      if (!id || !current) continue;
      const status = stringField(payload, "status")?.toLowerCase() ?? "";
      agents.set(id, { ...current, state: status.includes("fail") ? "failed" : "done" });
    }
  }
  return [...agents.values()];
}

export function deriveVerificationActivity(events: TerminusSseEvent[]): VerificationActivity[] {
  const activity: VerificationActivity[] = [];
  for (const event of events) {
    const payload = eventPayload(event);
    if (!payload) continue;
    if (event.event === "verification.node_passed") {
      const node = stringField(payload, "node_id", "nodeId") ?? "Verification check";
      activity.push({ id: event.id, state: "passed", detail: node });
    } else if (event.event === "verification.node_failed") {
      const node = stringField(payload, "node_id", "nodeId") ?? "Verification check";
      const reason = stringField(payload, "reason");
      activity.push({ id: event.id, state: "failed", detail: reason ? `${node}: ${reason}` : node });
    } else if (event.event === "verification.plan_completed") {
      const status = stringField(payload, "status")?.toLowerCase();
      const passed = payload.passed === true || status === "all_passed" || status === "passed";
      activity.push({ id: event.id, state: passed ? "passed" : "failed", detail: passed ? "Verification plan passed" : "Verification plan failed" });
    }
  }
  return activity;
}

export function deriveComputerUseActivity(events: TerminusSseEvent[]): ComputerUseActivity {
  let active = false;
  let paused = false;
  for (const event of events) {
    if (event.event === "computer_use.started" || event.event === "computer-use.started") {
      active = true;
      paused = false;
    } else if (event.event === "computer_use.paused" || event.event === "computer-use.paused") {
      if (active) paused = true;
    } else if (event.event === "computer_use.resumed" || event.event === "computer-use.resumed") {
      if (active) paused = false;
    } else if (
      event.event === "computer_use.stopped"
      || event.event === "computer-use.stopped"
      || event.event === "computer_use.completed"
      || event.event === "computer-use.completed"
    ) {
      active = false;
      paused = false;
    }
  }
  return { active, paused };
}

/**
 * The current event protocol has no dedicated diff artifact event. Patch tool
 * payloads may carry a unified diff, which we surface only when present rather
 * than inventing a synthetic review payload.
 */
export function extractUnifiedDiffs(events: TerminusSseEvent[]): string[] {
  const diffs = new Set<string>();
  for (const event of events) {
    if (event.event !== "tool.proposed" && event.event !== "tool.settled") continue;
    const payload = eventPayload(event);
    if (!payload) continue;
    const nested = [payload, payload.args, payload.result].filter(
      (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value),
    );
    for (const value of nested) {
      for (const field of ["diff", "patch", "unified_diff"]) {
        const candidate = stringField(value, field);
        if (candidate?.includes("diff --git ")) diffs.add(candidate);
      }
    }
  }
  return [...diffs];
}
