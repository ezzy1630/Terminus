/**
 * @terminus/adapter-sdk — external harness adapter SDK (SPEC §12.4, §35.11–35.12).
 *
 * Adapters are untrusted. Inner-harness self-report is never sufficient.
 * Live probes produce observed capabilities; discrepancies may disable.
 */
import type { Rfc3339Timestamp, ArtifactRef } from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import type {
  AdapterCapabilityProfile,
  AdapterResult,
  ExternalAdapter,
} from "./types.js";

export * from "./types.js";
export { validateAdapterResult, validateCapabilityProfile } from "./validate.js";
export {
  StdioJsonRpcAdapter,
  type AdapterProcessPort,
  type AdapterChildSession,
} from "./stdio_adapter.js";
export * from "./adapters.js";
export * from "./conformance.js";

export const adapterCapabilityProfileSchema = {
  exactContextVisibility: ["full", "partial", "opaque"] as const,
  toolInterception: ["full", "partial", "none"] as const,
  filesystemEnforcement: ["native", "outer_sandbox", "none"] as const,
  networkEnforcement: ["native", "outer_sandbox", "none"] as const,
  secretIsolation: ["native", "outer_broker", "none"] as const,
  sessionResume: ["native", "emulated", "none"] as const,
  typedResults: ["native", "parsed", "none"] as const,
  artifactExport: ["complete", "partial", "none"] as const,
  cancellation: ["reliable", "best_effort", "none"] as const,
  modelSelection: ["controlled", "constrained", "opaque"] as const,
};

export interface AdapterRegistry {
  register(adapter: ExternalAdapter): Promise<void>;
  get(adapterId: string): Promise<ExternalAdapter | null>;
  list(): Promise<readonly ExternalAdapter[]>;
  disable(adapterId: string, reason: string): Promise<void>;
}

export class InMemoryAdapterRegistry implements AdapterRegistry {
  private readonly adapters = new Map<string, ExternalAdapter>();
  private readonly disabled = new Map<string, string>();

  async register(adapter: ExternalAdapter): Promise<void> {
    this.adapters.set(adapter.adapterId, adapter);
  }

  async get(adapterId: string): Promise<ExternalAdapter | null> {
    if (this.disabled.has(adapterId)) return null;
    return this.adapters.get(adapterId) ?? null;
  }

  async list(): Promise<readonly ExternalAdapter[]> {
    return [...this.adapters.values()].filter((a) => !this.disabled.has(a.adapterId));
  }

  async disable(adapterId: string, reason: string): Promise<void> {
    this.disabled.set(adapterId, reason);
  }
}

import { validateCapabilityProfile as validateCapabilityProfileImpl } from "./validate.js";

export function verifyAdapterCompletion(
  adapterResult: AdapterResult,
  verificationPassed: boolean,
): { readonly verifiedStatus: "completed" | "failed"; readonly reason: string } {
  if (adapterResult.status === "completed" && !verificationPassed) {
    return {
      verifiedStatus: "failed",
      reason: "adapter claimed completion but independent verification engine checks failed",
    };
  }
  return {
    verifiedStatus: adapterResult.status === "completed" ? "completed" : "failed",
    reason:
      adapterResult.status === "completed"
        ? "all verification criteria satisfied"
        : "adapter reported failure",
  };
}

export interface IndependentVerificationInput {
  readonly adapterResult: AdapterResult;
  readonly observedChangedFiles: readonly string[];
  readonly independentChecksPassed: boolean;
  readonly workspaceInspectArtifact: ArtifactRef | null;
}

export function independentlyVerifyHarnessResult(
  input: IndependentVerificationInput,
): {
  readonly verifiedStatus: "completed" | "failed";
  readonly reason: string;
  readonly discrepancies: readonly string[];
} {
  const discrepancies: string[] = [];
  const claimed = new Set(input.adapterResult.changedFiles);
  const observed = new Set(input.observedChangedFiles);
  for (const f of claimed) {
    if (!observed.has(f)) discrepancies.push(`claimed change not observed: ${f}`);
  }
  for (const f of observed) {
    if (!claimed.has(f)) discrepancies.push(`observed change not claimed: ${f}`);
  }
  if (!input.independentChecksPassed) {
    return {
      verifiedStatus: "failed",
      reason: "independent verification predicates failed",
      discrepancies,
    };
  }
  if (input.adapterResult.status === "completed" && input.workspaceInspectArtifact === null) {
    return {
      verifiedStatus: "failed",
      reason: "missing independent workspace inspect artifact",
      discrepancies,
    };
  }
  const base = verifyAdapterCompletion(input.adapterResult, input.independentChecksPassed);
  if (discrepancies.length > 0 && base.verifiedStatus === "completed") {
    return {
      verifiedStatus: "failed",
      reason: "adapter changed-files claim diverged from independent workspace inspect",
      discrepancies,
    };
  }
  return { ...base, discrepancies };
}

export interface ProbeChecklist {
  readonly exactContextVisibility: AdapterCapabilityProfile["exactContextVisibility"];
  readonly toolInterception: AdapterCapabilityProfile["toolInterception"];
  readonly filesystemEnforcement: AdapterCapabilityProfile["filesystemEnforcement"];
  readonly networkEnforcement: AdapterCapabilityProfile["networkEnforcement"];
  readonly secretIsolation: AdapterCapabilityProfile["secretIsolation"];
  readonly sessionResume: AdapterCapabilityProfile["sessionResume"];
  readonly typedResults: AdapterCapabilityProfile["typedResults"];
  readonly artifactExport: AdapterCapabilityProfile["artifactExport"];
  readonly cancellation: AdapterCapabilityProfile["cancellation"];
  readonly modelSelection: AdapterCapabilityProfile["modelSelection"];
  readonly nativeCompaction: boolean;
}

export interface CapabilityProbeReport {
  readonly adapterId: string;
  readonly probedAt: Rfc3339Timestamp;
  readonly declared: AdapterCapabilityProfile;
  readonly observed: AdapterCapabilityProfile;
  readonly discrepancies: readonly string[];
  readonly disableRecommended: boolean;
}

export function runCapabilityProbe(
  adapterId: string,
  declared: AdapterCapabilityProfile,
  observedChecklist: ProbeChecklist,
  probedAt: Rfc3339Timestamp,
): CapabilityProbeReport {
  const observed: AdapterCapabilityProfile = {
    ...observedChecklist,
    observedByProbe: probedAt,
    lastVerified: declared.lastVerified,
  };
  const { discrepancies } = validateCapabilityProfileImpl(declared, observed);
  const critical = discrepancies.some(
    (d) =>
      d.startsWith("filesystemEnforcement:") ||
      d.startsWith("networkEnforcement:") ||
      d.startsWith("secretIsolation:"),
  );
  return {
    adapterId,
    probedAt,
    declared,
    observed,
    discrepancies,
    disableRecommended: critical,
  };
}

export function applyProbeToRegistry(
  registry: AdapterRegistry,
  report: CapabilityProbeReport,
): Promise<void> {
  if (report.disableRecommended) {
    return registry.disable(
      report.adapterId,
      `capability probe discrepancies: ${report.discrepancies.join("; ")}`,
    );
  }
  return Promise.resolve();
}

export { ValidationError };
