/**
 * @terminus/remote — single-tenant remote deployment contracts (SPEC §48.14).
 *
 * Pure TypeScript mirrors of crates/terminus-remote for control-plane use.
 * No network I/O here; transport lives in kernel-uds / kernel-mtls bridges.
 */
import { z } from "zod";
import {
  asControlId,
  asKernelId,
  asServerId,
  type ControlId,
  type KernelId,
  type ServerId,
} from "@terminus/domain";

export const CollaborationRole = {
  OWNER: "owner",
  EDITOR: "editor",
  VIEWER: "viewer",
  AUDITOR: "auditor",
} as const;
export type CollaborationRole = (typeof CollaborationRole)[keyof typeof CollaborationRole];

export const EffectState = {
  PROPOSED: "PROPOSED",
  APPROVED: "APPROVED",
  STARTED: "STARTED",
  SETTLED: "SETTLED",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN",
  RECONCILING: "RECONCILING",
  MANUAL_REVIEW: "MANUAL_REVIEW",
} as const;
export type EffectState = (typeof EffectState)[keyof typeof EffectState];

export const ExecutionMode = {
  LOCAL: "local",
  REMOTE: "remote",
} as const;
export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];

export interface DeploymentIdentities {
  readonly server: ServerId;
  readonly kernel: KernelId;
  readonly control: ControlId;
}

export const deploymentIdentitiesSchema = z.object({
  server: z.string().regex(/^server:[^\s:]+$/),
  kernel: z.string().regex(/^kernel:[^\s:]+$/),
  control: z.string().regex(/^control:[^\s:]+$/),
});

export function parseDeploymentIdentities(raw: unknown): DeploymentIdentities {
  const parsed = deploymentIdentitiesSchema.parse(raw);
  return {
    server: asServerId(parsed.server),
    kernel: asKernelId(parsed.kernel),
    control: asControlId(parsed.control),
  };
}

export interface DurableEffectRecord {
  readonly effectId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly kernelIdentity: KernelId;
  readonly state: EffectState;
  readonly executionMode: ExecutionMode;
  readonly evidenceRefs: readonly string[];
}

export const durableEffectRecordSchema = z.object({
  effectId: z.string().min(1),
  taskId: z.string().min(1),
  workspaceId: z.string().min(1),
  kernelIdentity: z.string().regex(/^kernel:[^\s:]+$/),
  state: z.enum([
    "PROPOSED",
    "APPROVED",
    "STARTED",
    "SETTLED",
    "FAILED",
    "UNKNOWN",
    "RECONCILING",
    "MANUAL_REVIEW",
  ]),
  executionMode: z.enum(["local", "remote"]),
  evidenceRefs: z.array(z.string()),
});

/** Local and remote durable records match when identity/task/state/evidence match. */
export function durableRecordsEquivalent(
  local: DurableEffectRecord,
  remote: DurableEffectRecord,
): boolean {
  return (
    local.effectId === remote.effectId &&
    local.taskId === remote.taskId &&
    local.workspaceId === remote.workspaceId &&
    local.state === remote.state &&
    local.evidenceRefs.length === remote.evidenceRefs.length &&
    local.evidenceRefs.every((ref, i) => ref === remote.evidenceRefs[i])
  );
}

const ALLOWED_DISCONNECT: ReadonlySet<EffectState> = new Set([
  EffectState.UNKNOWN,
  EffectState.FAILED,
  EffectState.MANUAL_REVIEW,
  EffectState.SETTLED,
  EffectState.RECONCILING,
]);

/**
 * Apply disconnect to a started effect. Never returns SETTLED from STARTED.
 */
export function onDisconnect(state: EffectState): EffectState {
  switch (state) {
    case EffectState.STARTED:
      return EffectState.UNKNOWN;
    case EffectState.PROPOSED:
    case EffectState.APPROVED:
      return EffectState.FAILED;
    default:
      return state;
  }
}

export function disconnectPreservesSafety(before: EffectState, after: EffectState): boolean {
  if (before === EffectState.STARTED && after === EffectState.SETTLED) {
    return false;
  }
  return ALLOWED_DISCONNECT.has(after) || after === before;
}

export interface PinnedImage {
  readonly repository: string;
  readonly digest: string;
}

export function parsePinnedImage(reference: string): PinnedImage {
  const at = reference.lastIndexOf("@");
  if (at < 0) {
    throw new TypeError("mutable image tags are forbidden; use repo@sha256:<hex>");
  }
  const repository = reference.slice(0, at);
  const digest = reference.slice(at + 1);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new TypeError("image digest must be sha256:<64-hex>");
  }
  if (repository.length === 0) {
    throw new TypeError("empty image repository");
  }
  return { repository, digest };
}

export function assertKernelPeer(expected: KernelId, presented: string): void {
  if (presented !== expected) {
    throw new Error(`identity isolation violation: peer ${presented} != ${expected}`);
  }
}

export type { KernelId, ServerId, ControlId };
