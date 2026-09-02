import { describe, expect, test } from "bun:test";
import { classifyVerificationTier } from "./risk-tier.js";

describe("verification risk tiers", () => {
  test("Tier 0 requires an unchanged workspace", () => {
    expect(classifyVerificationTier({ riskClass: "normal", changedFiles: [] }).tier).toBe(0);
  });

  test("Tier 1 is limited to explicitly low-risk support files", () => {
    expect(classifyVerificationTier({
      riskClass: "low",
      changedFiles: ["docs/guide.md", "tests/fixtures/result.snap"],
    }).tier).toBe(1);
    expect(classifyVerificationTier({ riskClass: "normal", changedFiles: ["docs/guide.md"] }).tier).toBe(2);
  });

  test("ordinary and ambiguous mutations use Tier 2", () => {
    expect(classifyVerificationTier({ riskClass: "normal", changedFiles: ["src/index.ts"] }).tier).toBe(2);
    expect(classifyVerificationTier({ riskClass: "low", changedFiles: ["unknown.file"] }).tier).toBe(2);
  });

  test("risk class and sensitive paths force Tier 3", () => {
    expect(classifyVerificationTier({ riskClass: "high", changedFiles: ["docs/note.md"] }).tier).toBe(3);
    expect(classifyVerificationTier({ riskClass: "normal", changedFiles: ["src/auth/token.ts"] }).tier).toBe(3);
    expect(classifyVerificationTier({ riskClass: "normal", changedFiles: ["migrations/001.sql"] }).tier).toBe(3);
  });
});
