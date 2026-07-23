import { describe, test, expect } from "bun:test";
import { validateCapabilityProfile, validateAdapterResult, verifyAdapterCompletion, type AdapterCapabilityProfile } from "./index.js";

import type { Rfc3339Timestamp } from "@terminus/domain";

describe("Adapter SDK Unit Tests", () => {
  const profile: AdapterCapabilityProfile = {
    exactContextVisibility: "full",
    toolInterception: "full",
    filesystemEnforcement: "native",
    networkEnforcement: "native",
    secretIsolation: "native",
    sessionResume: "native",
    typedResults: "native",
    artifactExport: "complete",
    cancellation: "reliable",
    modelSelection: "controlled",
    nativeCompaction: true,
    observedByProbe: "2026-07-22T14:50:00Z" as Rfc3339Timestamp,
    lastVerified: "2026-07-22T14:50:00Z" as Rfc3339Timestamp,
  };

  test("validateCapabilityProfile detects discrepancies", () => {
    const observed: AdapterCapabilityProfile = {
      ...profile,
      filesystemEnforcement: "none",
    };

    const res = validateCapabilityProfile(profile, observed);
    expect(res.ok).toBe(false);
    expect(res.discrepancies.length).toBeGreaterThan(0);
  });

  test("verifyAdapterCompletion prevents trusting harness claims without verification", () => {
    const res = verifyAdapterCompletion(
      {
        status: "completed",
        summary: "done",
        changedFiles: [],
        commit: null,
        tests: [],
        findings: [],
        risks: [],
        unresolved: [],
        artifacts: [],
        actualBudget: {},
      },
      false,
    );

    expect(res.verifiedStatus).toBe("failed");
    expect(res.reason).toContain("independent verification engine checks failed");
  });
});
