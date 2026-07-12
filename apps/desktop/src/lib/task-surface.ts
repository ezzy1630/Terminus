/**
 * Small, defensive projections from the runtime event stream into desktop
 * surfaces. The control plane remains the source of truth; this module only
 * derives presentation state from its existing event contract.
 */
import type { TerminusSseEvent } from "../types";

export interface PendingApproval {
  id: string;
  action: string;
  risk: "low" | "normal" | "high" | "critical";
  reversibility?: string;
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

function approvalRisk(value: string | undefined): PendingApproval["risk"] {
  return value === "low" || value === "high" || value === "critical" ? value : "normal";
}

export function derivePendingApprovals(events: TerminusSseEvent[]): PendingApproval[] {
  const pending = new Map<string, PendingApproval>();
  for (const event of events) {
    const payload = eventPayload(event);
    if (!payload) continue;
    if (event.event === "approval.requested") {
      const id = stringField(payload, "approval_id", "approvalId");
      if (!id) continue;
      pending.set(id, {
        id,
        action: stringField(payload, "operation_summary", "operationSummary") ?? "Authorize requested operation",
        risk: approvalRisk(stringField(payload, "risk")),
        reversibility: stringField(payload, "reversibility"),
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
