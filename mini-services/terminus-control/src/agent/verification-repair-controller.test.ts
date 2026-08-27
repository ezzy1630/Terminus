import { describe, expect, test } from "bun:test";
import {
  ProgressDetector,
  VerificationRepairController,
  buildRepairContext,
  normalizeFailure,
} from "./verification-repair-controller.js";
import type { RawVerificationFailure } from "./verification-repair-controller.js";

function rawFailure(nodeId: string, output: string, exitCode = 1): RawVerificationFailure {
  return {
    nodeId,
    predicateType: "unit_test",
    command: "bun test",
    exitCode,
    output,
    artifactRefs: ["artifact://sha256/abc"],
  };
}

describe("normalizeFailure", () => {
  test("produces a stable signature for identical diagnostics", () => {
    const first = normalizeFailure(rawFailure("n1", "assertion failed at line 4"));
    const second = normalizeFailure(rawFailure("n1", "assertion failed at line 4"));
    expect(first.signatureHash).toBe(second.signatureHash);
    expect(first.diagnostic).toBe("assertion failed at line 4");
    expect(first.artifactRefs).toEqual(["artifact://sha256/abc"]);
  });

  test("different diagnostics yield different signatures", () => {
    const a = normalizeFailure(rawFailure("n1", "expected 2 got 3"));
    const b = normalizeFailure(rawFailure("n1", "expected 2 got 4"));
    expect(a.signatureHash).not.toBe(b.signatureHash);
  });

  test("changed evidence yields different signatures regardless of reference order", () => {
    const first = normalizeFailure({
      ...rawFailure("n1", "same diagnostic"),
      artifactRefs: ["artifact://sha256/b", "artifact://sha256/a", "artifact://sha256/a"],
    });
    const sameObservation = normalizeFailure({
      ...rawFailure("n1", "same diagnostic"),
      artifactRefs: ["artifact://sha256/a", "artifact://sha256/b"],
    });
    const changedObservation = normalizeFailure({
      ...rawFailure("n1", "same diagnostic"),
      artifactRefs: ["artifact://sha256/a", "artifact://sha256/c"],
    });
    expect(first.signatureHash).toBe(sameObservation.signatureHash);
    expect(first.signatureHash).not.toBe(changedObservation.signatureHash);
    expect(first.artifactRefs).toEqual(["artifact://sha256/a", "artifact://sha256/b"]);
  });

  test("bounds huge outputs to the failing tail with an elision marker", () => {
    const huge = `${"x".repeat(10_000)}TAIL-MARKER`;
    const normalized = normalizeFailure(rawFailure("n1", huge));
    expect(normalized.diagnostic.length).toBeLessThan(5_000);
    expect(normalized.diagnostic).toContain("elided");
    expect(normalized.diagnostic).toContain("TAIL-MARKER");
  });
});

describe("VerificationRepairController", () => {
  test("first failure always admits one repair attempt", () => {
    const controller = new VerificationRepairController();
    const decision = controller.decideAfterFailure({
      failures: [normalizeFailure(rawFailure("n1", "boom"))],
      workspaceChangedSinceLastAttempt: true,
      actorReportedBlocker: false,
      requiresUserAuthority: false,
    });
    expect(decision.action).toBe("repair");
  });

  test("repeated identical failures without workspace change stop the loop", () => {
    const controller = new VerificationRepairController();
    controller.decideAfterFailure({
      failures: [normalizeFailure(rawFailure("n1", "same"))],
      workspaceChangedSinceLastAttempt: true,
      actorReportedBlocker: false,
      requiresUserAuthority: false,
    });
    const second = controller.decideAfterFailure({
      failures: [normalizeFailure(rawFailure("n1", "same"))],
      workspaceChangedSinceLastAttempt: false,
      actorReportedBlocker: false,
      requiresUserAuthority: false,
    });
    expect(second.action).toBe("stop");
    if (second.action === "stop") expect(second.reason).toBe("no_progress_repeated_failure");
  });

  test("a changed failure signature keeps repair alive", () => {
    const controller = new VerificationRepairController();
    controller.decideAfterFailure({
      failures: [normalizeFailure(rawFailure("n1", "v1"))],
      workspaceChangedSinceLastAttempt: true,
      actorReportedBlocker: false,
      requiresUserAuthority: false,
    });
    const second = controller.decideAfterFailure({
      failures: [normalizeFailure(rawFailure("n1", "different failure now"))],
      workspaceChangedSinceLastAttempt: true,
      actorReportedBlocker: false,
      requiresUserAuthority: false,
    });
    expect(second.action).toBe("repair");
  });

  test("repair budget is bounded", () => {
    const controller = new VerificationRepairController({ maxRepairAttempts: 1 });
    controller.decideAfterFailure({
      failures: [normalizeFailure(rawFailure("n1", "a"))],
      workspaceChangedSinceLastAttempt: true,
      actorReportedBlocker: false,
      requiresUserAuthority: false,
    });
    // Simulate the repaired-but-still-failing second evaluation.
    controller.decideAfterFailure({
      failures: [normalizeFailure(rawFailure("n1", "b"))],
      workspaceChangedSinceLastAttempt: true,
      actorReportedBlocker: false,
      requiresUserAuthority: false,
    });
    const third = controller.decideAfterFailure({
      failures: [normalizeFailure(rawFailure("n1", "c"))],
      workspaceChangedSinceLastAttempt: true,
      actorReportedBlocker: false,
      requiresUserAuthority: false,
    });
    expect(third.action).toBe("stop");
    if (third.action === "stop") expect(third.reason).toBe("repair_budget_exhausted");
  });

  test("restores durable usage and failure signatures across a new controller", () => {
    const prior = normalizeFailure(rawFailure("n1", "same"));
    const controller = new VerificationRepairController({
      maxRepairAttempts: 2,
      priorAttemptsUsed: 1,
      priorFailureSignatures: [prior.signatureHash],
    });
    const decision = controller.decideAfterFailure({
      failures: [prior],
      workspaceChangedSinceLastAttempt: false,
      actorReportedBlocker: false,
      requiresUserAuthority: false,
    });
    expect(decision).toEqual({ action: "stop", reason: "no_progress_repeated_failure" });
    expect(controller.attemptsUsed).toBe(1);
  });

  test("user-authority requirements stop before any repair spend", () => {
    const controller = new VerificationRepairController();
    const decision = controller.decideAfterFailure({
      failures: [normalizeFailure(rawFailure("n1", "missing credentials"))],
      workspaceChangedSinceLastAttempt: true,
      actorReportedBlocker: false,
      requiresUserAuthority: true,
    });
    expect(decision.action).toBe("stop");
    if (decision.action === "stop") expect(decision.reason).toBe("requires_user_authority");
  });

  test("actor-reported blockers stop the loop", () => {
    const controller = new VerificationRepairController();
    const decision = controller.decideAfterFailure({
      failures: [],
      workspaceChangedSinceLastAttempt: true,
      actorReportedBlocker: true,
      requiresUserAuthority: false,
    });
    expect(decision.action).toBe("stop");
    if (decision.action === "stop") expect(decision.reason).toBe("actor_reports_blocker");
  });
});

describe("ProgressDetector", () => {
  test("tracks repeated signature sets across attempts", () => {
    const detector = new ProgressDetector();
    detector.recordAttempt([normalizeFailure(rawFailure("n1", "x"))], true);
    const analysis = detector.recordAttempt(
      [normalizeFailure(rawFailure("n1", "x"))],
      false,
    );
    expect(analysis.progressed).toBe(false);
    expect(detector.attempts).toBe(2);
  });
});

describe("buildRepairContext", () => {
  test("includes failed claims, changed files, and prior attempt guidance", () => {
    const context = buildRepairContext({
      failures: [normalizeFailure(rawFailure("verify-tests", "AssertionError: expected 42"))],
      changedFiles: ["src/calc.ts"],
      previousAttemptSummary: "Tried widening the numeric cast.",
    });
    expect(context).toContain("# Verification failed");
    expect(context).toContain("verify-tests");
    expect(context).toContain("expected 42");
    expect(context).toContain("src/calc.ts");
    expect(context).toContain("change the hypothesis");
  });
});
