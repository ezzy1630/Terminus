/**
 * External adapter SDK conformance checks — Boundary C honesty + schema.
 */
import type { AdapterCapabilityProfile, ExternalAdapter } from "./types.js";
import { validateAdapterResult } from "./validate.js";
import { validateCapabilityProfile } from "./validate.js";

export interface ConformanceCase {
  readonly id: string;
  readonly description: string;
  readonly pass: boolean;
  readonly detail: string;
}

export function runAdapterConformance(
  adapter: ExternalAdapter,
  sampleResult: unknown,
  observedProfile: AdapterCapabilityProfile | null,
): readonly ConformanceCase[] {
  const cases: ConformanceCase[] = [];

  cases.push({
    id: "adapter-id-nonempty",
    description: "adapter declares non-empty id and version",
    pass: adapter.adapterId.length > 0 && adapter.version.length > 0,
    detail: `${adapter.adapterId}@${adapter.version}`,
  });

  const schema = validateAdapterResult(sampleResult, false);
  cases.push({
    id: "result-schema",
    description: "collectResult payload validates against AdapterResult schema",
    pass: schema.ok,
    detail: schema.ok ? "ok" : schema.reason,
  });

  if (observedProfile) {
    const probe = validateCapabilityProfile(adapter.capabilityProfile, observedProfile);
    cases.push({
      id: "capability-honesty",
      description: "declared capabilities match observed probe (or discrepancies documented)",
      pass: probe.ok,
      detail: probe.ok ? "no discrepancies" : probe.discrepancies.join("; "),
    });
  }

  const claimsNativeAll =
    adapter.capabilityProfile.filesystemEnforcement === "native" &&
    adapter.capabilityProfile.networkEnforcement === "native" &&
    adapter.capabilityProfile.secretIsolation === "native";
  cases.push({
    id: "honesty-or-outer-sandbox",
    description: "non-fixture adapters must not silently claim full native enforcement",
    pass: adapter.adapterId === "fixture-agent" || !claimsNativeAll,
    detail: claimsNativeAll ? "suspicious full-native claim" : "ok",
  });

  return cases;
}

export function conformancePassed(cases: readonly ConformanceCase[]): boolean {
  return cases.every((c) => c.pass);
}
