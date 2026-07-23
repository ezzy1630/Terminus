/**
 * Worker scope/capability enforcement and typed DelegationResult validation.
 * Per SPEC §37.7, Appendix E.4.
 */
import { z } from "zod";
import type {
  Delegation,
  DelegationResult,
  DelegationRole,
  AllowedScope,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";

const delegationTestSchema = z.object({
  command: z.string(),
  status: z.enum(["passed", "failed", "skipped", "error"]),
  evidence: z.string().nullable(),
  sourceRevision: z.string(),
});

const delegationResultSchema = z.object({
  status: z.enum(["completed", "blocked", "failed", "budget_exhausted", "policy_denied"]),
  summary: z.string().max(4000),
  changedFiles: z.array(z.string()),
  commit: z.string().nullable(),
  tests: z.array(delegationTestSchema),
  findings: z.array(z.string()),
  risks: z.array(z.string()),
  unresolved: z.array(z.string()).default([]),
  artifacts: z.array(z.unknown()),
  actualBudget: z.record(z.string(), z.unknown()).optional(),
});

export type ValidatedDelegationResult = DelegationResult;

export interface CapabilityCheck {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

/** Enforce required/forbidden capabilities and scope write/read paths. */
export function enforceWorkerCapabilities(
  delegation: Delegation,
  requestedCapabilities: readonly string[],
  effectPaths: { readonly reads: readonly string[]; readonly writes: readonly string[] },
): CapabilityCheck {
  const violations: string[] = [];
  for (const cap of requestedCapabilities) {
    if (delegation.forbiddenCapabilities.includes(cap)) {
      violations.push(`forbidden capability '${cap}'`);
    }
    if (
      delegation.requiredCapabilities.length > 0 &&
      !delegation.requiredCapabilities.includes(cap) &&
      !cap.startsWith("filesystem.read")
    ) {
      // Allow unspecified read; deny undeclared write-class caps.
      if (cap.includes("write") || cap.includes("exec") || cap.includes("network")) {
        violations.push(`undeclared capability '${cap}'`);
      }
    }
  }
  for (const p of effectPaths.writes) {
    if (!pathAllowed(p, delegation.allowedWritePaths)) {
      violations.push(`write path '${p}' outside scope`);
    }
  }
  for (const p of effectPaths.reads) {
    if (
      delegation.allowedReadPaths.length > 0 &&
      !pathAllowed(p, delegation.allowedReadPaths)
    ) {
      violations.push(`read path '${p}' outside scope`);
    }
  }
  return { ok: violations.length === 0, violations };
}

function pathAllowed(path: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return false;
  for (const g of globs) {
    if (g === "**" || g === path) return true;
    if (g.endsWith("/**") && path.startsWith(g.slice(0, -2))) return true;
    if (g.endsWith("/*")) {
      const prefix = g.slice(0, -1);
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) return true;
    }
    if (path.startsWith(`${g}/`) || path === g) return true;
  }
  return false;
}

/**
 * Decode + validate a worker result. Role-specific invariants:
 * - scout: no changed files / commit
 * - implementer: changed files must be within write scope
 * - reviewer: no changed files (reviewer cannot edit in the same run)
 */
export function validateWorkerResult(
  delegation: Delegation,
  raw: unknown,
): ValidatedDelegationResult {
  const parsed = delegationResultSchema.safeParse(normalizeResult(raw));
  if (!parsed.success) {
    throw new ValidationError("delegation result failed schema validation", {
      issues: parsed.error.issues.map((i) => i.message),
    });
  }
  const data = parsed.data;
  const result: DelegationResult = {
    status: data.status,
    summary: data.summary,
    changedFiles: data.changedFiles,
    commit: data.commit,
    tests: data.tests.map((t) => ({
      command: t.command,
      status: t.status,
      evidence: t.evidence,
      sourceRevision: t.sourceRevision,
    })),
    findings: data.findings,
    risks: data.risks,
    unresolved: data.unresolved,
    artifacts: data.artifacts.map((a) => coerceArtifactRef(a)),
    actualBudget: (data.actualBudget ?? {}) as DelegationResult["actualBudget"],
  };
  applyRoleInvariants(delegation.role, delegation.scope, result);
  return result;
}

function normalizeResult(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = raw as Record<string, unknown>;
  // Accept both camelCase (domain) and snake_case (Appendix E.4 JSON).
  return {
    status: o["status"],
    summary: o["summary"],
    changedFiles: o["changedFiles"] ?? o["changed_files"] ?? [],
    commit: o["commit"] ?? null,
    tests: o["tests"] ?? [],
    findings: o["findings"] ?? [],
    risks: o["risks"] ?? [],
    unresolved: o["unresolved"] ?? [],
    artifacts: normalizeArtifacts(o["artifacts"] ?? []),
    actualBudget: o["actualBudget"] ?? o["actual_budget"] ?? {},
  };
}

function normalizeArtifacts(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => {
    if (typeof a === "string") return { uri: a };
    return a;
  });
}

function coerceArtifactRef(raw: unknown): DelegationResult["artifacts"][number] {
  if (typeof raw === "string") {
    const hash = raw.includes("sha256/")
      ? (`sha256:${raw.split("sha256/")[1] ?? "0".repeat(64)}` as DelegationResult["artifacts"][number]["hash"])
      : (`sha256:${"0".repeat(64)}` as DelegationResult["artifacts"][number]["hash"]);
    return {
      hash,
      uri: raw as DelegationResult["artifacts"][number]["uri"],
      mediaType: "application/octet-stream",
      bytes: 0n as DelegationResult["artifacts"][number]["bytes"],
    };
  }
  if (raw !== null && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    return {
      hash: String(o["hash"] ?? "sha256:" + "0".repeat(64)) as DelegationResult["artifacts"][number]["hash"],
      uri: String(o["uri"] ?? "artifact://sha256/" + "0".repeat(64)) as DelegationResult["artifacts"][number]["uri"],
      mediaType: String(o["mediaType"] ?? "application/octet-stream"),
      bytes: (typeof o["bytes"] === "bigint" ? o["bytes"] : 0n) as DelegationResult["artifacts"][number]["bytes"],
    };
  }
  throw new ValidationError("invalid artifact ref in delegation result");
}

function applyRoleInvariants(
  role: DelegationRole,
  scope: AllowedScope,
  result: DelegationResult,
): void {
  switch (role) {
    case "scout":
      if (result.changedFiles.length > 0 || result.commit !== null) {
        throw new ValidationError("scout result must be read-only");
      }
      break;
    case "reviewer":
      if (result.changedFiles.length > 0 || result.commit !== null) {
        throw new ValidationError("reviewer cannot edit in the same run");
      }
      break;
    case "implementer":
    case "specialist":
      for (const f of result.changedFiles) {
        if (!pathAllowed(f, scope.writePaths)) {
          throw new ValidationError("worker changed file outside write scope", { file: f });
        }
      }
      break;
    default: {
      const _exhaustive: never = role;
      void _exhaustive;
    }
  }
}

export function assertCapabilityCheck(check: CapabilityCheck): void {
  if (!check.ok) {
    throw new ValidationError("worker capability/scope violation", {
      violations: check.violations,
    });
  }
}
