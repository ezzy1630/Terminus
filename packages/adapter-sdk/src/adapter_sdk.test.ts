import { describe, test, expect } from "bun:test";
import {
  validateCapabilityProfile,
  validateAdapterResult,
  verifyAdapterCompletion,
  independentlyVerifyHarnessResult,
  runCapabilityProbe,
  createPiAdapter,
  type AdapterCapabilityProfile,
  type AdapterProcessPort,
} from "./index.js";

import type { ArtifactRef, Rfc3339Timestamp } from "@terminus/domain";

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

  test("validateAdapterResult uses zod schema", () => {
    const bad = validateAdapterResult({ status: "completed" }, true);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.mayRetry).toBe(true);
  });

  test("independentlyVerifyHarnessResult requires workspace inspect", () => {
    const res = independentlyVerifyHarnessResult({
      adapterResult: {
        status: "completed",
        summary: "done",
        changedFiles: ["x.ts"],
        commit: null,
        tests: [],
        findings: [],
        risks: [],
        unresolved: [],
        artifacts: [],
        actualBudget: {},
      },
      observedChangedFiles: ["x.ts"],
      independentChecksPassed: true,
      workspaceInspectArtifact: null,
    });
    expect(res.verifiedStatus).toBe("failed");
  });

  test("runCapabilityProbe surfaces Pi-style discrepancies", () => {
    const port: AdapterProcessPort = {
      async spawn() {
        throw new Error("unused");
      },
    };
    const adapter = createPiAdapter(port, () => "2026-07-23T00:00:00Z" as Rfc3339Timestamp);
    const report = runCapabilityProbe(
      adapter.adapterId,
      adapter.capabilityProfile,
      {
        exactContextVisibility: adapter.capabilityProfile.exactContextVisibility,
        toolInterception: adapter.capabilityProfile.toolInterception,
        filesystemEnforcement: "none",
        networkEnforcement: adapter.capabilityProfile.networkEnforcement,
        secretIsolation: adapter.capabilityProfile.secretIsolation,
        sessionResume: adapter.capabilityProfile.sessionResume,
        typedResults: adapter.capabilityProfile.typedResults,
        artifactExport: adapter.capabilityProfile.artifactExport,
        cancellation: adapter.capabilityProfile.cancellation,
        modelSelection: adapter.capabilityProfile.modelSelection,
        nativeCompaction: adapter.capabilityProfile.nativeCompaction,
      },
      "2026-07-23T00:00:00Z" as Rfc3339Timestamp,
    );
    expect(report.discrepancies.length).toBeGreaterThan(0);
    expect(report.disableRecommended).toBe(true);
  });

  test("artifact typed for independent verify", () => {
    const artifact: ArtifactRef = {
      hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ArtifactRef["hash"],
      uri: "artifact://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ArtifactRef["uri"],
      mediaType: "application/json",
      bytes: 1n as ArtifactRef["bytes"],
    };
    const res = independentlyVerifyHarnessResult({
      adapterResult: {
        status: "completed",
        summary: "done",
        changedFiles: [],
        commit: null,
        tests: [],
        findings: [],
        risks: [],
        unresolved: [],
        artifacts: [artifact],
        actualBudget: {},
      },
      observedChangedFiles: [],
      independentChecksPassed: true,
      workspaceInspectArtifact: artifact,
    });
    expect(res.verifiedStatus).toBe("completed");
  });
});
