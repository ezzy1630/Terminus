import { describe, expect, it } from "bun:test";
import { formatDoctorReportText, runDoctor } from "./index.js";

describe("terminus doctor", () => {
  it("executes all diagnostic probes and generates a valid report", async () => {
    const report = await runDoctor({ profile: "native" });

    expect(report.schemaVersion).toBe(1);
    expect(report.profile).toBe("native");
    expect(report.categories.length).toBeGreaterThanOrEqual(5);

    // Verify categories
    const categoryNames = report.categories.map((c) => c.name);
    expect(categoryNames).toContain("database");
    expect(categoryNames).toContain("kernel");
    expect(categoryNames).toContain("sandbox");
    expect(categoryNames).toContain("providers");
    expect(categoryNames).toContain("workspace");
    expect(categoryNames).toContain("maturity");

    // Verify summary
    expect(report.summary.total).toBeGreaterThan(0);
    expect(report.summary.passed + report.summary.warned + report.summary.failed + report.summary.skipped).toBe(
      report.summary.total,
    );

    // Verify formatting
    const formatted = formatDoctorReportText(report);
    expect(formatted).toContain("TERMINUS SYSTEM DOCTOR");
    expect(formatted).toContain("OVERALL STATUS");
  });

  it("evaluates production invariants strictly under production profile", async () => {
    const report = await runDoctor({ profile: "production" });

    expect(report.profile).toBe("production");
    // Under macOS or un-configured Linux runner, sandbox or other invariant probes may report warnings
    if (!report.invariants.passed) {
      expect(report.invariants.violations.length).toBeGreaterThan(0);
      expect(report.summary.status).toBe("failing");
    }
  });

  it("formats text output with verbose details when enabled", async () => {
    const report = await runDoctor({ profile: "native" });
    const formattedVerbose = formatDoctorReportText(report, true);
    expect(formattedVerbose).toContain("Details:");
  });
});
