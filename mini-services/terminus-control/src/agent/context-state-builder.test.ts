import { describe, expect, test } from "bun:test";
import { ContextStateBuilder } from "./context-state-builder.js";
import type { EpisodeObservation } from "./context-state-builder.js";

function observation(toolName: string, data: Record<string, unknown>): EpisodeObservation {
  return {
    toolName,
    resultJson: JSON.stringify({ status: "success", data }),
  };
}

describe("ContextStateBuilder", () => {
  const baseInput = {
    taskId: "018f0000-0000-7000-8000-000000000001" as never,
    contractVersion: 1,
    contractContentHash: "sha256:" + "a".repeat(64) as never,
    phase: "EXECUTE",
    unknowns: [] as readonly string[],
    observedAt: "2026-08-24T00:00:00Z" as never,
    workspace: { workspaceId: "ws", rootUri: "file:///ws", trust: "trusted" },
    environment: { sandboxProfileId: "secure-local-default", backendId: "linux" },
    episodeObservations: [] as readonly EpisodeObservation[],
  };

  test("first compile of a turn reports empty signals (no fabricated state)", () => {
    const built = new ContextStateBuilder().build(baseInput);
    expect(built.taskSnapshot.changedFiles).toEqual([]);
    expect(built.taskSnapshot.failingTests).toEqual([]);
    expect(built.worldStateSections.verification).toEqual({ status: "pending" });
  });

  test("patch episodes surface changed files to the compiler", () => {
    const built = new ContextStateBuilder().build({
      ...baseInput,
      episodeObservations: [
        observation("patch", {
          changed_files: [
            { path: "src/index.ts", new_sha256: "sha256:bb", operation: "EDIT" },
          ],
        }),
      ],
    });
    expect(built.taskSnapshot.changedFiles).toEqual(["src/index.ts"]);
    expect(built.worldStateSections.changes).not.toBeNull();
    expect(built.worldStateDigest).not.toBe(new ContextStateBuilder().build(baseInput).worldStateDigest);
  });

  test("failing test output reaches the compiler as failingTests", () => {
    const built = new ContextStateBuilder().build({
      ...baseInput,
      episodeObservations: [
        observation("exec", {
          exit_code: 1,
          stdout: "",
          stderr:
            "FAILED tests/test_auth.py::test_login - AssertionError: assert False\n",
        }),
      ],
    });
    expect(built.taskSnapshot.failingTests[0]).toContain("tests/test_auth.py::test_login");
  });

  test("compiler diagnostics keep path/message structure", () => {
    const built = new ContextStateBuilder().build({
      ...baseInput,
      episodeObservations: [
        observation("exec", {
          exit_code: 1,
          stdout: "src/app.ts(10,5): error TS2345: bad arg",
          stderr: "",
        }),
      ],
    });
    expect(built.taskSnapshot.diagnostics).toEqual([
      { path: "src/app.ts", message: "L10: bad arg" },
    ]);
  });

  test("prior verification failures mark verification failed with the failure list", () => {
    const built = new ContextStateBuilder().build({
      ...baseInput,
      priorVerificationFailures: ["unit_tests"],
    });
    expect(built.worldStateSections.verification).toEqual({
      status: "failed",
      failures: ["unit_tests"],
    });
  });

  test("environment identity is included for reproducibility", () => {
    const built = new ContextStateBuilder().build(baseInput);
    expect(built.worldStateSections.environment).toEqual({
      sandbox_profile: "secure-local-default",
      backend: "linux",
    });
  });
});
